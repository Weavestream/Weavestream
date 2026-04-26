import { createUserSchema } from '@weavestream/shared';

/**
 * Phase 9b.2 schema coverage for the optional `membership` block on
 * `createUserSchema`. The base user validation is exercised indirectly
 * through the existing users.controller e2e tests, so this file stays
 * narrow on the new surface.
 */
describe('createUserSchema — invite-with-company (Phase 9b.2)', () => {
  const base = { email: 'x@y.com', name: 'X', role: 'CLIENT_USER' as const };

  it('accepts a payload with no membership block (unchanged path)', () => {
    const out = createUserSchema.safeParse(base);
    expect(out.success).toBe(true);
  });

  it('accepts a valid membership block', () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const out = createUserSchema.safeParse({
      ...base,
      membership: {
        companyId: '00000000-0000-4000-8000-000000000001',
        role: 'READONLY',
        expiresAt: future,
      },
    });
    expect(out.success).toBe(true);
    if (out.success) {
      expect(out.data.membership?.companyId).toBe(
        '00000000-0000-4000-8000-000000000001',
      );
      expect(out.data.membership?.expiresAt).toBe(future);
    }
  });

  it('omits expiresAt when the caller did', () => {
    const out = createUserSchema.safeParse({
      ...base,
      membership: {
        companyId: '00000000-0000-4000-8000-000000000001',
        role: 'READONLY',
      },
    });
    expect(out.success).toBe(true);
    if (out.success) {
      expect(out.data.membership?.expiresAt).toBeUndefined();
    }
  });

  it('rejects a non-UUID companyId', () => {
    const out = createUserSchema.safeParse({
      ...base,
      membership: {
        companyId: 'not-a-uuid',
        role: 'READONLY',
      },
    });
    expect(out.success).toBe(false);
  });

  it('rejects an unknown membership role', () => {
    const out = createUserSchema.safeParse({
      ...base,
      membership: {
        companyId: '00000000-0000-4000-8000-000000000001',
        role: 'SUPER_ADMIN',
      },
    });
    expect(out.success).toBe(false);
  });

  it('rejects a past expiresAt', () => {
    const past = new Date(Date.now() - 86_400_000).toISOString();
    const out = createUserSchema.safeParse({
      ...base,
      membership: {
        companyId: '00000000-0000-4000-8000-000000000001',
        role: 'READONLY',
        expiresAt: past,
      },
    });
    expect(out.success).toBe(false);
  });

  it('allows an explicit null expiresAt', () => {
    const out = createUserSchema.safeParse({
      ...base,
      membership: {
        companyId: '00000000-0000-4000-8000-000000000001',
        role: 'READONLY',
        expiresAt: null,
      },
    });
    expect(out.success).toBe(true);
  });
});
