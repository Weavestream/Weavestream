import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { REQUIRE_PERMISSION_KEY } from '../rbac/require-permission.decorator.js';
import { IntegrationMatchFieldController } from './integration-match-field.controller.js';
import { IntegrationMatchFieldService } from './integration-match-field.service.js';
import { IntegrationDriverRegistry } from './drivers/integration-driver.registry.js';

const ADMIN = { id: 'user-1', role: 'SUPER_ADMIN' } as never;
const META = { ip: '203.0.113.1', userAgent: 'jest' };
const LAYOUT_ID = '00000000-0000-4000-8000-000000000001';

function field(overrides: Record<string, unknown>) {
  return {
    id: 'f-name', name: 'Name', slug: 'name', fieldType: 'TEXT', position: 0, isRequired: true, isUniquePerCompany: false,
    visibleToClients: true, isPrimary: true, showInTable: true, options: {}, archivedAt: null, ...overrides,
  };
}

function setup(driver: string, fields: ReturnType<typeof field>[]) {
  const layouts = {
    get: jest.fn().mockResolvedValue({ id: LAYOUT_ID, isActive: true, archivedAt: null, fields }),
    saveFields: jest.fn(),
    // Mirrors AssetLayoutsService.addField: reuse a live field with the slug, else create one.
    addField: jest.fn().mockImplementation(async (_actor, _id, input: { slug: string }) => {
      const hit = fields.find((f) => f.slug === input.slug && f.archivedAt === null);
      return hit ? { field: hit, created: false } : { field: { ...input, id: 'f-new' }, created: true };
    }),
  };
  const prisma = { integration: { findUnique: jest.fn().mockResolvedValue({ driver }) } };
  const service = new IntegrationMatchFieldService(prisma as never, new IntegrationDriverRegistry(), layouts as never);
  return { service, layouts };
}

describe('IntegrationMatchFieldService', () => {
  it('adds only the missing match field, never resubmitting the read snapshot', async () => {
    const { service, layouts } = setup('level', [field({})]);
    await expect(service.ensureMatchField(ADMIN, 'i-1', 'devices', LAYOUT_ID, META)).resolves.toEqual({ fieldId: 'f-new', created: true });
    // A snapshot-based saveFields would archive any field added after the read.
    expect(layouts.saveFields).not.toHaveBeenCalled();
    const [, layoutId, input, meta] = layouts.addField.mock.calls[0]!;
    expect(layoutId).toBe(LAYOUT_ID);
    expect(meta).toBe(META);
    expect(input).toEqual(expect.objectContaining({ slug: 'serial_number', name: 'Serial number', fieldType: 'TEXT', isRequired: false }));
  });

  it('reuses an existing field with the same slug and type without saving', async () => {
    const { service, layouts } = setup('google-workspace', [field({}), field({ id: 'f-email', name: 'Email', slug: 'email', fieldType: 'EMAIL', isPrimary: false })]);
    await expect(service.ensureMatchField(ADMIN, 'i-1', 'users', LAYOUT_ID, META)).resolves.toEqual({ fieldId: 'f-email', created: false });
  });

  it('refuses when a field with that slug has another type, and never alters it', async () => {
    const { service, layouts } = setup('google-workspace', [field({}), field({ id: 'f-email', name: 'Email', slug: 'email', fieldType: 'TEXT', isPrimary: false })]);
    const error = await service.ensureMatchField(ADMIN, 'i-1', 'users', LAYOUT_ID, META).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as Error).message).toMatch(/already has a field "Email" \(email\) of type TEXT/);
    expect(layouts.saveFields).not.toHaveBeenCalled();
  });

  it('ignores archived fields when looking for the slug', async () => {
    const { service } = setup('level', [field({}), field({ id: 'f-old', slug: 'serial_number', isPrimary: false, archivedAt: new Date() })]);
    await expect(service.ensureMatchField(ADMIN, 'i-1', 'devices', LAYOUT_ID, META)).resolves.toMatchObject({ created: true });
  });

  it('refuses inactive layouts, unknown resources and client users', async () => {
    const { service, layouts } = setup('level', [field({})]);
    layouts.get.mockResolvedValueOnce({ id: LAYOUT_ID, isActive: false, archivedAt: null, fields: [] });
    await expect(service.ensureMatchField(ADMIN, 'i-1', 'devices', LAYOUT_ID, META)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.ensureMatchField(ADMIN, 'i-1', 'nope', LAYOUT_ID, META)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.ensureMatchField({ id: 'u', role: 'CLIENT_USER' } as never, 'i-1', 'devices', LAYOUT_ID, META)).rejects.toBeInstanceOf(ForbiddenException);
    expect(layouts.addField).not.toHaveBeenCalled();
  });

  it('creates a standard field by source key with its label, slug and type', async () => {
    const { service, layouts } = setup('level', [field({})]);
    await expect(service.ensureMatchField(ADMIN, 'i-1', 'devices', LAYOUT_ID, META, 'ip_address')).resolves.toEqual({ fieldId: 'f-new', created: true });
    expect(layouts.addField.mock.calls[0]![2]).toEqual(expect.objectContaining({ slug: 'ip_address', name: 'IP address', fieldType: 'IP_ADDRESS', showInTable: false }));
  });

  it('reuses a same-slug text field for a standard fact, refuses an incompatible one and unknown keys', async () => {
    const text = setup('level', [field({}), field({ id: 'f-ip', name: 'IP', slug: 'ip_address', fieldType: 'TEXT', isPrimary: false })]);
    await expect(text.service.ensureMatchField(ADMIN, 'i-1', 'devices', LAYOUT_ID, META, 'ip_address')).resolves.toEqual({ fieldId: 'f-ip', created: false });
    const dropdown = setup('level', [field({}), field({ id: 'f-role', name: 'Role', slug: 'role', fieldType: 'DROPDOWN', isPrimary: false })]);
    await expect(dropdown.service.ensureMatchField(ADMIN, 'i-1', 'devices', LAYOUT_ID, META, 'role')).rejects.toBeInstanceOf(BadRequestException);
    await expect(dropdown.service.ensureMatchField(ADMIN, 'i-1', 'devices', LAYOUT_ID, META, 'asset_tag')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('is gated by integration.manage', () => {
    expect(Reflect.getMetadata(REQUIRE_PERMISSION_KEY, IntegrationMatchFieldController.prototype.ensureMatchField)).toEqual({
      action: 'integration.manage',
      companyIdFrom: undefined,
    });
  });

  it('also requires layout.manage.global, and refuses with 403 without it', async () => {
    const ensureMatchField = jest.fn().mockResolvedValue({ fieldId: 'f', created: true });
    const can = jest.fn().mockResolvedValue({ allowed: false });
    const controller = new IntegrationMatchFieldController({ ensureMatchField } as never, { can } as never);
    const req = { headers: {}, ip: '198.51.100.7' } as never;
    const dto = { assetLayoutId: LAYOUT_ID };
    await expect(controller.ensureMatchField(ADMIN, 'i-1', 'devices', dto, req)).rejects.toBeInstanceOf(ForbiddenException);
    expect(can).toHaveBeenCalledWith(ADMIN, 'layout.manage.global');
    expect(ensureMatchField).not.toHaveBeenCalled();
    can.mockResolvedValue({ allowed: true });
    await expect(controller.ensureMatchField(ADMIN, 'i-1', 'devices', dto, req)).resolves.toEqual({ fieldId: 'f', created: true });
  });
});
