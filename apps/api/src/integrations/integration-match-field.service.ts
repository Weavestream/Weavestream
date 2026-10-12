import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  standardFieldTargetCompatible,
  type DriverResourceDescriptor,
  type DriverStandardField,
  type EnsureResourceMatchFieldResult,
  type FieldType,
} from '@weavestream/shared';
import type { AuthedUser } from '../common/current-user.decorator.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AssetLayoutsService } from '../asset-layouts/asset-layouts.service.js';
import { IntegrationDriverRegistry } from './drivers/integration-driver.registry.js';
import type { RecommendedDestination } from './drivers/integration-driver.js';
import { minimalRecommendation, type AuditMeta } from './integrations.service.js';

interface WantedField {
  name: string;
  slug: string;
  fieldType: FieldType;
  showInTable: boolean;
  options: Record<string, unknown>;
}

/** The match-key field from the driver's recommended destination. */
function matchFieldSpec(
  recommendation: RecommendedDestination | undefined,
  resource: DriverResourceDescriptor,
): WantedField | undefined {
  const sourceField = resource.matchSuggestions?.sourceField;
  if (!recommendation || !sourceField) return undefined;
  return minimalRecommendation(recommendation, resource).fields.find((field) => field.sourceField === sourceField);
}

/** A standard field: its label, its source key as the slug, never shown in the table by default. */
function standardFieldSpec(fields: DriverStandardField[] | undefined, sourceField: string): WantedField | undefined {
  const spec = fields?.find((field) => field.sourceField === sourceField);
  return spec
    ? { name: spec.label, slug: spec.sourceField, fieldType: spec.fieldType, showInTable: false, options: {} }
    : undefined;
}

/**
 * "Map layouts" on an existing layout that lacks the field a resource
 * matches on: create that one field (name, slug and type from the driver's
 * recommended destination) through the layout service's add-one-field path, so
 * it is validated and audited like any field the operator adds. A field
 * with the same slug but another type is never altered. The same path
 * creates a resource's standard fields (hostname, OS, ...) when Map
 * layouts asks for one by `sourceField`.
 */
@Injectable()
export class IntegrationMatchFieldService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly drivers: IntegrationDriverRegistry,
    private readonly layouts: AssetLayoutsService,
  ) {}

  async ensureMatchField(
    actor: AuthedUser,
    integrationId: string,
    resourceKey: string,
    assetLayoutId: string,
    meta: AuditMeta,
    standardSourceField?: string,
  ): Promise<EnsureResourceMatchFieldResult> {
    // Defense in depth: client users never edit layouts.
    if (actor.role === 'CLIENT_USER') throw new ForbiddenException();
    const integration = await this.prisma.integration.findUnique({ where: { id: integrationId }, select: { driver: true } });
    if (!integration) throw new NotFoundException();
    const driver = this.drivers.get(integration.driver);
    const resource = driver.descriptor.resources.find((candidate) => candidate.key === resourceKey);
    if (!resource) throw new BadRequestException(`Unknown resource "${resourceKey}" for this integration.`);
    const wanted = standardSourceField !== undefined
      ? standardFieldSpec(resource.standardFields, standardSourceField)
      : matchFieldSpec(driver.recommendedDestinations?.[resourceKey], resource);
    if (resource.targetKind !== 'asset' || !wanted) {
      throw new BadRequestException(
        standardSourceField !== undefined
          ? `"${standardSourceField}" is not a standard field of this resource.`
          : 'This resource has no match field to create.',
      );
    }

    const layout = await this.layouts.get(actor, assetLayoutId);
    if (layout.archivedAt || !layout.isActive) throw new BadRequestException('Pick an active layout.');
    // Adds against the layout's current fields (not this read), so a field
    // added concurrently is never dropped.
    const { field, created } = await this.layouts.addField(
      actor,
      assetLayoutId,
      {
        name: wanted.name,
        slug: wanted.slug,
        fieldType: wanted.fieldType,
        isRequired: false,
        isUniquePerCompany: false,
        visibleToClients: true,
        isPrimary: false,
        showInTable: wanted.showInTable,
        options: wanted.options,
      },
      meta,
    );
    const fits = standardSourceField !== undefined
      ? standardFieldTargetCompatible(wanted.fieldType, field.fieldType)
      : field.fieldType === wanted.fieldType;
    if (!created && !fits) {
      throw new BadRequestException(
        `The layout already has a field "${field.name}" (${field.slug}) of type ${field.fieldType}, and this integration needs ${wanted.fieldType}. Pick another field.`,
      );
    }
    return { fieldId: field.id, created };
  }
}
