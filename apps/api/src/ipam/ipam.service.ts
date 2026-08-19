import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma, Subnet, IpReservation } from '@prisma/client';
import {
  createIpReservationSchema,
  createSubnetSchema,
  normalizeCidrV4,
  usableHostCount,
  ipInCidr,
  type CreateSubnetInput,
  type UpdateSubnetInput,
  type CreateIpReservationInput,
  type UpdateIpReservationInput,
} from '@weavestream/shared';
import type { IntegrationTargetProvenance } from '@weavestream/shared';
import { readTargetProvenance } from '../integrations/reconstruction/integration-provenance.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditLogService } from '../audit/audit.service.js';
import {
  hasEligibleNativeBinding,
  hasEligibleNativeSiblingBinding,
  hasEligibleNativeTargetBinding,
} from '../integrations/reconstruction/native-binding-ownership.js';
import { AUDIT_ACTIONS } from '../audit/audit-actions.js';
import type { AuthedUser } from '../common/current-user.decorator.js';
import { INTEGRATION_WRITE_ACTOR } from '../common/integration-write-actor.js';
import { isUniqueConstraintError } from '../prisma/prisma-errors.js';

export interface AuditMeta {
  ip: string;
  userAgent: string;
}

export interface IntegrationSubnetWriteInput {
  tx?: Prisma.TransactionClient;
  companyId: string;
  integrationId: string;
  integrationCompanyMappingId: string;
  resourceId: string;
  externalId: string;
  auditActorId: string;
  dryRun: boolean;
  existingTargetId?: string | null;
  name: string;
  cidr: string;
  vlanId?: number | null;
  gateway?: string | null;
  dhcpRangeStart?: string | null;
  dhcpRangeEnd?: string | null;
  description?: string | null;
}

export interface IntegrationReservationWriteInput {
  tx?: Prisma.TransactionClient;
  companyId: string;
  integrationId: string;
  integrationCompanyMappingId: string;
  resourceId: string;
  externalId: string;
  auditActorId: string;
  dryRun: boolean;
  existingTargetId?: string | null;
  subnetId: string;
  ipAddress: string;
  label: string;
  notes?: string | null;
}

export interface IntegrationIpamWriteResult {
  targetId: string;
  companyId: string;
  change: 'created' | 'updated' | 'unchanged' | 'restored' | 'blocked';
  gap?: {
    kind: 'missing_dependency' | 'validation' | 'ambiguous' | 'synchronization_error';
    message: string;
    details?: {
      reasonCode?: string;
      candidateCount?: number;
      fieldPaths?: string[];
    };
  };
}

const INTEGRATION_AUDIT_META: AuditMeta = {
  ip: '0.0.0.0',
  userAgent: 'weavestream-worker/integration-reconstruction',
};

export interface SubnetOccupant {
  ip: string;
  assetId: string;
  assetName: string;
  assetLayoutId: string;
  assetLayoutName: string;
  assetLayoutColor: string;
  assetLayoutIcon: string;
  assetFieldId: string;
  fieldName: string;
}

export interface SubnetUtilization {
  totalUsable: number;
  claimed: number;
  free: number;
  conflictCount: number;
}

export interface SubnetDetail {
  subnet: Subnet;
  utilization: SubnetUtilization;
  occupants: SubnetOccupant[];
  reservations: IpReservation[];
  conflicts: Array<{ ip: string; entries: SubnetOccupant[] }>;
  provenance: IntegrationTargetProvenance[];
}

@Injectable()
export class IpamService {
  private readonly logger = new Logger(IpamService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  // ------------------------------------------------------------------
  // Read
  // ------------------------------------------------------------------

  async listSubnets(
    _actor: AuthedUser,
    companyId: string,
    options: { includeArchived?: boolean; q?: string } = {},
  ): Promise<Subnet[]> {
    const where: Prisma.SubnetWhereInput = { companyId };
    if (!options.includeArchived) where.archivedAt = null;
    if (options.q) where.name = { contains: options.q, mode: 'insensitive' };
    return this.prisma.subnet.findMany({
      where,
      orderBy: [{ archivedAt: 'asc' }, { name: 'asc' }],
    });
  }

  async getSubnetById(
    _actor: AuthedUser,
    companyId: string,
    id: string,
  ): Promise<Subnet> {
    const row = await this.prisma.subnet.findFirst({
      where: { id, companyId },
    });
    if (!row) throw new NotFoundException('Subnet not found');
    return row;
  }

  async getSubnetDetail(
    actor: AuthedUser,
    companyId: string,
    id: string,
  ): Promise<SubnetDetail> {
    const subnet = await this.getSubnetById(actor, companyId, id);
    const [occupants, reservations] = await Promise.all([
      this.listOccupants(companyId, subnet.cidr),
      this.prisma.ipReservation.findMany({
        where: { subnetId: id, companyId },
        orderBy: { ipAddress: 'asc' },
      }),
    ]);

    const occupantIps = occupants.map((o) => o.ip);
    const reservationIps = reservations.map((r) => r.ipAddress);
    const utilization = computeUtilization(
      subnet.prefix,
      occupantIps,
      reservationIps,
    );

    const ipOccupants = new Map<string, SubnetOccupant[]>();
    for (const o of occupants) {
      const arr = ipOccupants.get(o.ip) ?? [];
      arr.push(o);
      ipOccupants.set(o.ip, arr);
    }
    const conflicts: SubnetDetail['conflicts'] = [];
    for (const [ip, entries] of ipOccupants) {
      if (entries.length > 1) conflicts.push({ ip, entries });
    }

    const provenance = await readTargetProvenance(this.prisma, {
      companyId,
      targetKind: 'subnet',
      targetId: id,
    });
    return { subnet, utilization, occupants, reservations, conflicts, provenance };
  }

  async listOccupants(
    companyId: string,
    cidr: string,
  ): Promise<SubnetOccupant[]> {
    // We deliberately avoid `::inet` casts on user-supplied data: a single
    // malformed value (e.g. an asset whose IP_ADDRESS field somehow holds
    // "10.0.0.35, 10.0.0.50" because of a legacy import or a driver that
    // bypassed validation) would otherwise abort the entire query with
    // `invalid input syntax for type inet`. Instead we pull candidate
    // strings through a strict regex (full-string IPv4, optional /N) and
    // do containment + canonicalisation in JS using the same helpers that
    // power the rest of the IPAM module.
    type Row = {
      raw: string;
      assetId: string;
      assetName: string;
      assetLayoutId: string;
      assetLayoutName: string;
      assetLayoutColor: string;
      assetLayoutIcon: string;
      assetFieldId: string;
      fieldName: string;
    };

    let rows: Row[];
    try {
      rows = await this.prisma.$queryRaw<Row[]>`
        SELECT
          (afv.value #>> '{}')                   AS "raw",
          afv.asset_id::text                     AS "assetId",
          a.name                                 AS "assetName",
          a.asset_layout_id::text                AS "assetLayoutId",
          al.name                                AS "assetLayoutName",
          al.color                               AS "assetLayoutColor",
          al.icon                                AS "assetLayoutIcon",
          afv.asset_field_id::text               AS "assetFieldId",
          af.name                                AS "fieldName"
        FROM asset_field_values afv
        JOIN asset_fields af  ON af.id = afv.asset_field_id AND af.field_type = 'IP_ADDRESS'
        JOIN assets a         ON a.id = afv.asset_id AND a.archived_at IS NULL
        JOIN asset_layouts al ON al.id = a.asset_layout_id
        WHERE afv.company_id = ${companyId}::uuid
          AND afv.value IS NOT NULL
          AND jsonb_typeof(afv.value) = 'string'
          AND (afv.value #>> '{}') ~ '^[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}(/[0-9]{1,2})?$'
      `;
    } catch (err) {
      this.logger.warn(`listOccupants query failed for CIDR ${cidr}: ${err}`);
      return [];
    }

    const out: SubnetOccupant[] = [];
    for (const row of rows) {
      // Strip any /N suffix — IPAM occupancy is a host-level concept; a
      // field storing "10.0.0.5/24" still occupies "10.0.0.5".
      const slash = row.raw.indexOf('/');
      const host = (slash >= 0 ? row.raw.slice(0, slash) : row.raw).trim();
      if (!ipInCidr(host, cidr)) continue;
      out.push({
        ip: host,
        assetId: row.assetId,
        assetName: row.assetName,
        assetLayoutId: row.assetLayoutId,
        assetLayoutName: row.assetLayoutName,
        assetLayoutColor: row.assetLayoutColor,
        assetLayoutIcon: row.assetLayoutIcon,
        assetFieldId: row.assetFieldId,
        fieldName: row.fieldName,
      });
    }

    out.sort((a, b) => compareIpv4(a.ip, b.ip));
    return out;
  }

  /**
   * List subnets with summary utilization (for the list page).
   */
  async listSubnetsWithUtilization(
    actor: AuthedUser,
    companyId: string,
    options: { includeArchived?: boolean; q?: string } = {},
  ): Promise<
    Array<Subnet & { utilization: SubnetUtilization; conflictCount: number }>
  > {
    const subnets = await this.listSubnets(actor, companyId, options);
    if (subnets.length === 0) return [];

    const reservationCounts = await this.prisma.ipReservation.groupBy({
      by: ['subnetId'],
      _count: true,
      where: { companyId, subnetId: { in: subnets.map((s) => s.id) } },
    });
    const resBySubnet = new Map(
      reservationCounts.map((r) => [r.subnetId, r._count]),
    );

    const results = await Promise.all(
      subnets.map(async (subnet) => {
        const occupants = await this.listOccupants(companyId, subnet.cidr);
        const occupantIps = occupants.map((o) => o.ip);
        const resCount = resBySubnet.get(subnet.id) ?? 0;

        const reservations = resCount > 0
          ? await this.prisma.ipReservation.findMany({
              where: { subnetId: subnet.id, companyId },
              select: { ipAddress: true },
            })
          : [];
        const reservationIps = reservations.map((r) => r.ipAddress);

        const utilization = computeUtilization(
          subnet.prefix,
          occupantIps,
          reservationIps,
        );

        const ipCounts = new Map<string, number>();
        for (const ip of occupantIps) {
          ipCounts.set(ip, (ipCounts.get(ip) ?? 0) + 1);
        }
        let conflictCount = 0;
        for (const count of ipCounts.values()) {
          if (count > 1) conflictCount++;
        }

        return { ...subnet, utilization, conflictCount };
      }),
    );

    return results;
  }

  // ------------------------------------------------------------------
  // Write — Subnets
  // ------------------------------------------------------------------

  async createSubnet(
    actor: AuthedUser,
    companyId: string,
    input: CreateSubnetInput,
    meta: AuditMeta,
  ): Promise<Subnet> {
    const cidr = normalizeCidrV4(input.cidr as string);
    if (!cidr) throw new BadRequestException('Invalid CIDR');
    const prefix = Number(cidr.split('/')[1]);

    await this.assertCidrFree(companyId, cidr, null);

    let row: Subnet;
    try {
      row = await this.prisma.subnet.create({
        data: {
          companyId,
          name: input.name,
          cidr,
          prefix,
          vlanId: input.vlanId ?? null,
          gateway: input.gateway ?? null,
          dhcpRangeStart: input.dhcpRangeStart ?? null,
          dhcpRangeEnd: input.dhcpRangeEnd ?? null,
          description: input.description ?? null,
          createdBy: actor.id,
          updatedBy: actor.id,
        },
      });
    } catch (error) {
      this.rethrowCidrConflict(error, cidr);
    }

    await this.audit.log({
      actorId: actor.id,
      action: AUDIT_ACTIONS.subnet.create,
      entityType: 'Subnet',
      entityId: row.id,
      companyId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      after: { name: row.name, cidr: row.cidr },
    });

    return row;
  }

  async updateSubnet(
    actor: AuthedUser,
    companyId: string,
    id: string,
    input: UpdateSubnetInput,
    meta: AuditMeta,
  ): Promise<Subnet> {
    const existing = await this.getSubnetById(actor, companyId, id);
    const before = { name: existing.name, cidr: existing.cidr };

    const data: Prisma.SubnetUpdateInput = { updatedBy: actor.id };
    if (input.name !== undefined) data.name = input.name;
    if (input.vlanId !== undefined) data.vlanId = input.vlanId ?? null;
    if (input.gateway !== undefined) data.gateway = input.gateway ?? null;
    if (input.dhcpRangeStart !== undefined)
      data.dhcpRangeStart = input.dhcpRangeStart ?? null;
    if (input.dhcpRangeEnd !== undefined)
      data.dhcpRangeEnd = input.dhcpRangeEnd ?? null;
    if (input.description !== undefined) data.description = input.description ?? null;

    if (input.cidr !== undefined) {
      const cidr = normalizeCidrV4(input.cidr as string);
      if (!cidr) throw new BadRequestException('Invalid CIDR');
      await this.assertCidrFree(companyId, cidr, id);
      data.cidr = cidr;
      data.prefix = Number(cidr.split('/')[1]);
    }

    try {
      await this.prisma.subnet.updateMany({
        where: { id, companyId },
        data,
      });
    } catch (error) {
      this.rethrowCidrConflict(error, String(data.cidr ?? existing.cidr));
    }
    const row = await this.getSubnetById(actor, companyId, id);

    await this.audit.log({
      actorId: actor.id,
      action: AUDIT_ACTIONS.subnet.update,
      entityType: 'Subnet',
      entityId: row.id,
      companyId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before,
      after: { name: row.name, cidr: row.cidr },
    });

    return row;
  }

  async writeSubnetFromIntegration(
    input: IntegrationSubnetWriteInput,
  ): Promise<IntegrationIpamWriteResult> {
    const runTransaction = <T>(callback: (tx: Prisma.TransactionClient) => Promise<T>) =>
      input.tx ? callback(input.tx) : this.prisma.$transaction(callback);
    await this.audit.assertIntegrationActor(input.auditActorId, input.companyId);
    let native: ReturnType<typeof createSubnetSchema.parse>;
    try {
      native = createSubnetSchema.parse({
        name: input.name,
        cidr: input.cidr,
        vlanId: input.vlanId,
        gateway: input.gateway,
        dhcpRangeStart: input.dhcpRangeStart,
        dhcpRangeEnd: input.dhcpRangeEnd,
        description: input.description,
      });
    } catch {
      return ipamBlocked(input.companyId, 'validation', 'Subnet input failed native validation.', 'native_validation');
    }
    const readClient = input.tx ?? this.prisma;

    const bound = input.existingTargetId
      ? await readClient.subnet.findUnique({ where: { id: input.existingTargetId } })
      : null;
    if (bound && bound.companyId !== input.companyId) {
      return { targetId: bound.id, companyId: bound.companyId, change: 'blocked' };
    }
    if (input.existingTargetId && !bound) {
      return ipamBlocked(input.companyId, 'missing_dependency', 'The bound subnet no longer exists.', 'target_not_found', input.existingTargetId);
    }
    const collision = await readClient.subnet.findFirst({
      where: {
        companyId: input.companyId,
        cidr: native.cidr,
        archivedAt: null,
        ...(bound ? { id: { not: bound.id } } : {}),
      },
    });
    if (collision && collision.companyId !== input.companyId) {
      return { targetId: collision.id, companyId: collision.companyId, change: 'blocked' };
    }
    const adoptedCanonicalTarget = !!collision;
    if (
      collision &&
      !(await this.hasEligibleIpamBinding(
        input.tx ?? this.prisma,
        input,
        'subnet',
        collision.id,
        true,
      ))
    ) {
      return ipamBlocked(input.companyId, 'ambiguous', 'An unbound subnet already owns this CIDR.', 'manual_ownership', collision.id);
    }
    const existing = collision ?? bound;
    if (existing) {
      await this.assertCidrFree(input.companyId, native.cidr, existing.id, readClient);
    }
    const sharedCanonicalTarget = !!existing && (
      adoptedCanonicalTarget ||
      await this.hasEligibleIpamSiblingBinding(
        readClient,
        input,
        'subnet',
        existing!.id,
      )
    );
    const incomingData: CanonicalSubnetData = {
      name: native.name,
      cidr: native.cidr,
      prefix: Number(native.cidr.split('/')[1]),
      vlanId: native.vlanId ?? null,
      gateway: native.gateway ?? null,
      dhcpRangeStart: native.dhcpRangeStart ?? null,
      dhcpRangeEnd: native.dhcpRangeEnd ?? null,
      description: native.description ?? null,
    };
    const canonical = existing && sharedCanonicalTarget
      ? reconcileCanonicalFields(existing, incomingData, SUBNET_CANONICAL_FIELDS)
      : { data: incomingData, conflicts: [] };
    if (canonical.conflicts.length > 0) {
      return ipamBlocked(
        input.companyId,
        'validation',
        'Canonical subnet sources disagree on shared fields.',
        'canonical_field_conflict',
        existing!.id,
        canonical.conflicts,
      );
    }

    const data = canonical.data;
    const changed =
      !existing ||
      existing.name !== data.name ||
      existing.cidr !== data.cidr ||
      existing.vlanId !== data.vlanId ||
      existing.gateway !== data.gateway ||
      existing.dhcpRangeStart !== data.dhcpRangeStart ||
      existing.dhcpRangeEnd !== data.dhcpRangeEnd ||
      existing.description !== data.description;
    const restored = existing?.archivedAt != null;
    if (input.dryRun) {
      if (existing && !(await this.hasEligibleIpamBinding(input.tx ?? this.prisma, input, 'subnet', existing.id, adoptedCanonicalTarget))) {
        return ipamBlocked(input.companyId, 'ambiguous', 'The existing subnet is not owned by an eligible reconstruction binding.', 'manual_ownership', existing.id);
      }
      return {
        targetId: existing?.id ?? '',
        companyId: input.companyId,
        change: existing ? (restored ? 'restored' : changed ? 'updated' : 'unchanged') : 'created',
      };
    }

    if (existing) {
      const change: IntegrationIpamWriteResult['change'] = restored ? 'restored' : changed ? 'updated' : 'unchanged';
      if (change === 'unchanged') {
        if (!(await this.hasEligibleIpamBinding(input.tx ?? this.prisma, input, 'subnet', existing.id, adoptedCanonicalTarget))) {
          return ipamBlocked(input.companyId, 'ambiguous', 'The existing subnet is not owned by an eligible reconstruction binding.', 'manual_ownership', existing.id);
        }
        return { targetId: existing.id, companyId: input.companyId, change };
      }
      return runTransaction(async (tx) => {
        if (!(await this.hasEligibleIpamBinding(tx, input, 'subnet', existing.id, adoptedCanonicalTarget))) {
          return ipamBlocked(input.companyId, 'ambiguous', 'The existing subnet is not owned by an eligible reconstruction binding.', 'manual_ownership', existing.id);
        }
        const applied = await tx.subnet.updateMany({
          where: {
            id: existing.id,
            companyId: input.companyId,
            archivedAt: existing.archivedAt,
            ...canonicalWritePremise(existing, SUBNET_CANONICAL_FIELDS),
          },
          data: { ...data, ...(restored ? { archivedAt: null } : {}), updatedBy: INTEGRATION_WRITE_ACTOR },
        });
        if (applied.count === 0) {
          return ipamBlocked(input.companyId, 'synchronization_error', 'The canonical subnet changed during reconciliation; the write was not applied.', 'canonical_write_race', existing.id);
        }
        const row = await tx.subnet.findFirstOrThrow({
          where: { id: existing.id, companyId: input.companyId },
        });
        await this.audit.logWithClient(tx, {
          actorId: input.auditActorId,
          action: change === 'restored' ? AUDIT_ACTIONS.subnet.restore : AUDIT_ACTIONS.subnet.update,
          entityType: 'Subnet',
          entityId: row.id,
          companyId: input.companyId,
          ip: INTEGRATION_AUDIT_META.ip,
          userAgent: INTEGRATION_AUDIT_META.userAgent,
          after: { integrationId: input.integrationId, cidr: row.cidr },
        });
        return { targetId: row.id, companyId: input.companyId, change };
      });
    }
    return runTransaction(async (tx) => {
      const row = await tx.subnet.create({
        data: { companyId: input.companyId, ...data, createdBy: INTEGRATION_WRITE_ACTOR, updatedBy: INTEGRATION_WRITE_ACTOR },
      });
      await this.audit.logWithClient(tx, {
        actorId: input.auditActorId,
        action: AUDIT_ACTIONS.subnet.create,
        entityType: 'Subnet',
        entityId: row.id,
        companyId: input.companyId,
        ip: INTEGRATION_AUDIT_META.ip,
        userAgent: INTEGRATION_AUDIT_META.userAgent,
        after: { integrationId: input.integrationId, cidr: row.cidr },
      });
      return { targetId: row.id, companyId: input.companyId, change: 'created' as const };
    });
  }

  async archiveSubnet(
    actor: AuthedUser,
    companyId: string,
    id: string,
    meta: AuditMeta,
  ): Promise<Subnet> {
    const existing = await this.getSubnetById(actor, companyId, id);
    if (existing.archivedAt) return existing;
    await this.prisma.subnet.updateMany({
      where: { id, companyId },
      data: { archivedAt: new Date(), updatedBy: actor.id },
    });
    const row = await this.getSubnetById(actor, companyId, id);

    await this.audit.log({
      actorId: actor.id,
      action: AUDIT_ACTIONS.subnet.archive,
      entityType: 'Subnet',
      entityId: row.id,
      companyId,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return row;
  }

  async restoreSubnet(
    actor: AuthedUser,
    companyId: string,
    id: string,
    meta: AuditMeta,
  ): Promise<Subnet> {
    const existing = await this.getSubnetById(actor, companyId, id);
    if (!existing.archivedAt) return existing;
    await this.assertCidrFree(companyId, existing.cidr, id);
    try {
      await this.prisma.subnet.updateMany({
        where: { id, companyId },
        data: { archivedAt: null, updatedBy: actor.id },
      });
    } catch (error) {
      this.rethrowCidrConflict(error, existing.cidr);
    }
    const row = await this.getSubnetById(actor, companyId, id);

    await this.audit.log({
      actorId: actor.id,
      action: AUDIT_ACTIONS.subnet.restore,
      entityType: 'Subnet',
      entityId: row.id,
      companyId,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return row;
  }

  // ------------------------------------------------------------------
  // Write — Reservations
  // ------------------------------------------------------------------

  async createReservation(
    actor: AuthedUser,
    companyId: string,
    subnetId: string,
    input: CreateIpReservationInput,
    meta: AuditMeta,
  ): Promise<IpReservation> {
    const subnet = await this.getSubnetById(actor, companyId, subnetId);
    if (!ipInCidr(input.ipAddress, subnet.cidr)) {
      throw new BadRequestException(
        `IP ${input.ipAddress} is not within subnet ${subnet.cidr}`,
      );
    }

    try {
      const row = await this.prisma.ipReservation.create({
        data: {
          companyId,
          subnetId,
          ipAddress: input.ipAddress,
          label: input.label,
          notes: input.notes ?? null,
          createdBy: actor.id,
          updatedBy: actor.id,
        },
      });

      await this.audit.log({
        actorId: actor.id,
        action: AUDIT_ACTIONS.subnet.reservationCreate,
        entityType: 'IpReservation',
        entityId: row.id,
        companyId,
        ip: meta.ip,
        userAgent: meta.userAgent,
        after: { ipAddress: row.ipAddress, label: row.label, subnetId },
      });

      return row;
    } catch (err: unknown) {
      if (
        err &&
        typeof err === 'object' &&
        'code' in err &&
        (err as { code: string }).code === 'P2002'
      ) {
        throw new ConflictException(
          `IP ${input.ipAddress} is already reserved in this subnet`,
        );
      }
      throw err;
    }
  }

  async updateReservation(
    actor: AuthedUser,
    companyId: string,
    subnetId: string,
    reservationId: string,
    input: UpdateIpReservationInput,
    meta: AuditMeta,
  ): Promise<IpReservation> {
    const subnet = await this.getSubnetById(actor, companyId, subnetId);
    const existing = await this.prisma.ipReservation.findFirst({
      where: { id: reservationId, subnetId, companyId },
    });
    if (!existing) throw new NotFoundException('Reservation not found');

    const data: Prisma.IpReservationUpdateInput = { updatedBy: actor.id };
    if (input.label !== undefined) data.label = input.label;
    if (input.notes !== undefined) data.notes = input.notes ?? null;
    if (input.ipAddress !== undefined) {
      if (!ipInCidr(input.ipAddress, subnet.cidr)) {
        throw new BadRequestException(
          `IP ${input.ipAddress} is not within subnet ${subnet.cidr}`,
        );
      }
      data.ipAddress = input.ipAddress;
    }

    try {
      await this.prisma.ipReservation.updateMany({
        where: { id: reservationId, companyId },
        data,
      });
      const row = await this.prisma.ipReservation.findFirstOrThrow({
        where: { id: reservationId, companyId },
      });

      await this.audit.log({
        actorId: actor.id,
        action: AUDIT_ACTIONS.subnet.reservationUpdate,
        entityType: 'IpReservation',
        entityId: row.id,
        companyId,
        ip: meta.ip,
        userAgent: meta.userAgent,
        before: { ipAddress: existing.ipAddress, label: existing.label },
        after: { ipAddress: row.ipAddress, label: row.label },
      });

      return row;
    } catch (err: unknown) {
      if (
        err &&
        typeof err === 'object' &&
        'code' in err &&
        (err as { code: string }).code === 'P2002'
      ) {
        throw new ConflictException(
          `IP ${input.ipAddress} is already reserved in this subnet`,
        );
      }
      throw err;
    }
  }

  async writeReservationFromIntegration(
    input: IntegrationReservationWriteInput,
  ): Promise<IntegrationIpamWriteResult> {
    const runTransaction = <T>(callback: (tx: Prisma.TransactionClient) => Promise<T>) =>
      input.tx ? callback(input.tx) : this.prisma.$transaction(callback);
    await this.audit.assertIntegrationActor(input.auditActorId, input.companyId);
    let native: ReturnType<typeof createIpReservationSchema.parse>;
    try {
      native = createIpReservationSchema.parse({
        ipAddress: input.ipAddress,
        label: input.label,
        notes: input.notes,
      });
    } catch {
      return ipamBlocked(input.companyId, 'validation', 'Reservation input failed native validation.', 'native_validation');
    }
    const readClient = input.tx ?? this.prisma;
    const subnet = await readClient.subnet.findUnique({ where: { id: input.subnetId } });
    if (!subnet) {
      return ipamBlocked(input.companyId, 'missing_dependency', 'The reservation subnet was not found.', 'dependency_not_found');
    }
    if (subnet.companyId !== input.companyId) {
      return ipamBlocked(input.companyId, 'validation', 'The reservation subnet belongs to another company.', 'dependency_company_mismatch', subnet.id);
    }
    if (!ipInCidr(native.ipAddress, subnet.cidr)) {
      return ipamBlocked(input.companyId, 'validation', 'The reservation IP is outside its subnet.', 'ip_outside_subnet');
    }
    const bound = input.existingTargetId
      ? await readClient.ipReservation.findUnique({ where: { id: input.existingTargetId } })
      : null;
    if (bound && bound.companyId !== input.companyId) {
      return { targetId: bound.id, companyId: bound.companyId, change: 'blocked' };
    }
    if (input.existingTargetId && !bound) {
      return ipamBlocked(input.companyId, 'missing_dependency', 'The bound reservation no longer exists.', 'target_not_found', input.existingTargetId);
    }
    const collision = await readClient.ipReservation.findFirst({
      where: {
        companyId: input.companyId,
        subnetId: input.subnetId,
        ipAddress: native.ipAddress,
        ...(bound ? { id: { not: bound.id } } : {}),
      },
    });
    if (collision && collision.companyId !== input.companyId) {
      return { targetId: collision.id, companyId: collision.companyId, change: 'blocked' };
    }
    const adoptedCanonicalTarget = !!collision;
    if (
      collision &&
      !(await this.hasEligibleIpamBinding(
        input.tx ?? this.prisma,
        input,
        'ip_reservation',
        collision.id,
        true,
      ))
    ) {
      return ipamBlocked(input.companyId, 'ambiguous', 'An unbound reservation already owns this IP.', 'manual_ownership', collision.id);
    }
    const existing = collision ?? bound;
    if (existing && existing.subnetId !== input.subnetId) {
      return ipamBlocked(input.companyId, 'validation', 'The bound reservation belongs to another subnet.', 'target_subnet_mismatch', existing.id);
    }
    const sharedCanonicalTarget = !!existing && (
      adoptedCanonicalTarget ||
      await this.hasEligibleIpamSiblingBinding(
        readClient,
        input,
        'ip_reservation',
        existing.id,
      )
    );
    const incomingData: CanonicalReservationData = {
      ipAddress: native.ipAddress,
      label: native.label,
      notes: native.notes ?? null,
    };
    const canonical = existing && sharedCanonicalTarget
      ? reconcileCanonicalFields(existing, incomingData, RESERVATION_CANONICAL_FIELDS)
      : { data: incomingData, conflicts: [] };
    if (canonical.conflicts.length > 0) {
      return ipamBlocked(
        input.companyId,
        'validation',
        'Canonical reservation sources disagree on shared fields.',
        'canonical_field_conflict',
        existing!.id,
        canonical.conflicts,
      );
    }
    const data = canonical.data;
    const changed =
      !existing ||
      existing.ipAddress !== data.ipAddress ||
      existing.label !== data.label ||
      existing.notes !== data.notes;
    if (input.dryRun) {
      if (existing && !(await this.hasEligibleIpamBinding(input.tx ?? this.prisma, input, 'ip_reservation', existing.id, adoptedCanonicalTarget))) {
        return ipamBlocked(input.companyId, 'ambiguous', 'The existing reservation is not owned by an eligible reconstruction binding.', 'manual_ownership', existing.id);
      }
      return { targetId: existing?.id ?? '', companyId: input.companyId, change: existing ? (changed ? 'updated' : 'unchanged') : 'created' };
    }
    const change: IntegrationIpamWriteResult['change'] = existing ? (changed ? 'updated' : 'unchanged') : 'created';
    if (existing) {
      if (!changed) {
        if (!(await this.hasEligibleIpamBinding(input.tx ?? this.prisma, input, 'ip_reservation', existing.id, adoptedCanonicalTarget))) {
          return ipamBlocked(input.companyId, 'ambiguous', 'The existing reservation is not owned by an eligible reconstruction binding.', 'manual_ownership', existing.id);
        }
        return { targetId: existing.id, companyId: input.companyId, change };
      }
      return runTransaction(async (tx) => {
        if (!(await this.hasEligibleIpamBinding(tx, input, 'ip_reservation', existing.id, adoptedCanonicalTarget))) {
          return ipamBlocked(input.companyId, 'ambiguous', 'The existing reservation is not owned by an eligible reconstruction binding.', 'manual_ownership', existing.id);
        }
        const applied = await tx.ipReservation.updateMany({
          where: {
            id: existing.id,
            companyId: input.companyId,
            subnetId: existing.subnetId,
            ...canonicalWritePremise(existing, RESERVATION_CANONICAL_FIELDS),
          },
          data: { ...data, updatedBy: INTEGRATION_WRITE_ACTOR },
        });
        if (applied.count === 0) {
          return ipamBlocked(input.companyId, 'synchronization_error', 'The canonical reservation changed during reconciliation; the write was not applied.', 'canonical_write_race', existing.id);
        }
        const row = await tx.ipReservation.findFirstOrThrow({
          where: { id: existing.id, companyId: input.companyId },
        });
        await this.audit.logWithClient(tx, {
          actorId: input.auditActorId,
          action: AUDIT_ACTIONS.subnet.reservationUpdate,
          entityType: 'IpReservation',
          entityId: row.id,
          companyId: input.companyId,
          ip: INTEGRATION_AUDIT_META.ip,
          userAgent: INTEGRATION_AUDIT_META.userAgent,
          after: { integrationId: input.integrationId, subnetId: input.subnetId },
        });
        return { targetId: row.id, companyId: input.companyId, change };
      });
    }
    return runTransaction(async (tx) => {
      const row = await tx.ipReservation.create({
        data: {
          companyId: input.companyId,
          subnetId: input.subnetId,
          ...data,
          createdBy: INTEGRATION_WRITE_ACTOR,
          updatedBy: INTEGRATION_WRITE_ACTOR,
        },
      });
      await this.audit.logWithClient(tx, {
        actorId: input.auditActorId,
        action: AUDIT_ACTIONS.subnet.reservationCreate,
        entityType: 'IpReservation',
        entityId: row.id,
        companyId: input.companyId,
        ip: INTEGRATION_AUDIT_META.ip,
        userAgent: INTEGRATION_AUDIT_META.userAgent,
        after: { integrationId: input.integrationId, subnetId: input.subnetId },
      });
      return { targetId: row.id, companyId: input.companyId, change: 'created' as const };
    });
  }

  private hasEligibleIpamBinding(
    client: Parameters<typeof hasEligibleNativeBinding>[0],
    input: IntegrationSubnetWriteInput | IntegrationReservationWriteInput,
    targetKind: 'subnet' | 'ip_reservation',
    targetId: string,
    allowCanonicalTarget = false,
  ): Promise<boolean> {
    const identity = {
      integrationCompanyMappingId: input.integrationCompanyMappingId,
      resourceId: input.resourceId,
      integrationId: input.integrationId,
      companyId: input.companyId,
      targetKind,
      targetId,
    };
    return hasEligibleNativeBinding(client, { ...identity, externalId: input.externalId }).then(
      (exact) =>
        exact || !allowCanonicalTarget
          ? exact
          : hasEligibleNativeTargetBinding(client, identity),
    );
  }

  private hasEligibleIpamSiblingBinding(
    client: Parameters<typeof hasEligibleNativeSiblingBinding>[0],
    input: IntegrationSubnetWriteInput | IntegrationReservationWriteInput,
    targetKind: 'subnet' | 'ip_reservation',
    targetId: string,
  ): Promise<boolean> {
    return hasEligibleNativeSiblingBinding(client, {
      integrationCompanyMappingId: input.integrationCompanyMappingId,
      resourceId: input.resourceId,
      externalId: input.externalId,
      integrationId: input.integrationId,
      companyId: input.companyId,
      targetKind,
      targetId,
    });
  }

  async deleteReservation(
    actor: AuthedUser,
    companyId: string,
    subnetId: string,
    reservationId: string,
    meta: AuditMeta,
  ): Promise<void> {
    await this.getSubnetById(actor, companyId, subnetId);
    const existing = await this.prisma.ipReservation.findFirst({
      where: { id: reservationId, subnetId, companyId },
    });
    if (!existing) throw new NotFoundException('Reservation not found');

    await this.prisma.ipReservation.deleteMany({
      where: { id: reservationId, companyId },
    });

    await this.audit.log({
      actorId: actor.id,
      action: AUDIT_ACTIONS.subnet.reservationDelete,
      entityType: 'IpReservation',
      entityId: reservationId,
      companyId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: { ipAddress: existing.ipAddress, label: existing.label },
    });
  }

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  private async assertCidrFree(
    companyId: string,
    cidr: string,
    excludeId: string | null,
    client: Pick<Prisma.TransactionClient, 'subnet'> | PrismaService = this.prisma,
  ): Promise<void> {
    // Text equality here IS canonical equality: `subnets_cidr_canonical_check`
    // pins `cidr` to `canonical_cidr::text`, and Prisma cannot bind CIDR
    // strings to the inet column (bare-IP parameter parsing).
    const where: Prisma.SubnetWhereInput = {
      companyId,
      cidr,
      archivedAt: null,
    };
    if (excludeId) where.id = { not: excludeId };
    const dup = await client.subnet.findFirst({ where });
    if (dup) {
      throw new ConflictException(
        `Subnet ${cidr} already exists for this company`,
      );
    }
  }

  private rethrowCidrConflict(error: unknown, cidr: string): never {
    if (isUniqueConstraintError(error)) {
      throw new ConflictException(
        `Subnet ${cidr} already exists for this company`,
      );
    }
    throw error;
  }
}

// Sort IPv4 addresses numerically (so 10.0.0.9 < 10.0.0.10). Strings
// that don't parse as four octets sort last so they don't crash the
// comparator if a malformed value ever sneaks past the SQL filter.
function compareIpv4(a: string, b: string): number {
  const ai = ipToUint32(a);
  const bi = ipToUint32(b);
  if (ai === null && bi === null) return a.localeCompare(b);
  if (ai === null) return 1;
  if (bi === null) return -1;
  return ai - bi;
}

function ipamBlocked(
  companyId: string,
  kind: 'missing_dependency' | 'validation' | 'ambiguous' | 'synchronization_error',
  message: string,
  reasonCode: string,
  targetId = '',
  fieldPaths?: string[],
): IntegrationIpamWriteResult {
  return {
    targetId,
    companyId,
    change: 'blocked',
    gap: {
      kind,
      message,
      details: {
        reasonCode,
        ...(fieldPaths?.length ? { fieldPaths } : {}),
      },
    },
  };
}

type CanonicalSubnetData = Pick<
  Subnet,
  | 'name'
  | 'cidr'
  | 'prefix'
  | 'vlanId'
  | 'gateway'
  | 'dhcpRangeStart'
  | 'dhcpRangeEnd'
  | 'description'
>;
type CanonicalReservationData = Pick<
  IpReservation,
  'ipAddress' | 'label' | 'notes'
>;
type CanonicalFieldPolicy<T> = {
  field: keyof T;
  path: string;
  nullable: boolean;
};

const SUBNET_CANONICAL_FIELDS: readonly CanonicalFieldPolicy<CanonicalSubnetData>[] = [
  { field: 'name', path: 'name', nullable: false },
  { field: 'cidr', path: 'cidr', nullable: false },
  { field: 'prefix', path: 'prefix', nullable: false },
  { field: 'vlanId', path: 'vlanId', nullable: true },
  { field: 'gateway', path: 'gateway', nullable: true },
  { field: 'dhcpRangeStart', path: 'dhcpRangeStart', nullable: true },
  { field: 'dhcpRangeEnd', path: 'dhcpRangeEnd', nullable: true },
  { field: 'description', path: 'description', nullable: true },
];

const RESERVATION_CANONICAL_FIELDS: readonly CanonicalFieldPolicy<CanonicalReservationData>[] = [
  { field: 'ipAddress', path: 'ipAddress', nullable: false },
  { field: 'label', path: 'label', nullable: false },
  { field: 'notes', path: 'notes', nullable: true },
];

/**
 * Canonical IPAM field policy:
 * - identity and required values must agree exactly;
 * - the first non-null optional value becomes canonical;
 * - an absent optional assertion preserves the canonical value;
 * - two differing non-null assertions block instead of overwriting.
 *
 * The reconciled data is only valid against the snapshot it was derived
 * from; integration writers re-assert that snapshot in the UPDATE's WHERE
 * clause (see canonicalWritePremise) so a concurrent commit surfaces as a
 * `canonical_write_race` gap instead of a lost update.
 */
function reconcileCanonicalFields<T extends object>(
  existing: T,
  incoming: T,
  policies: readonly CanonicalFieldPolicy<T>[],
): { data: T; conflicts: string[] } {
  const data = { ...incoming };
  const conflicts: string[] = [];
  for (const policy of policies) {
    const current = existing[policy.field];
    const next = incoming[policy.field];
    if (policy.nullable && next == null) {
      data[policy.field] = current;
      continue;
    }
    if (policy.nullable && current == null) continue;
    if (current !== next) conflicts.push(policy.path);
  }
  return { data, conflicts };
}

/**
 * WHERE fragment re-asserting the snapshot a reconciliation was derived
 * from. Guarding the UPDATE with it makes first-non-null adoption atomic
 * under READ COMMITTED: a concurrent commit changes the row, the predicate
 * matches zero rows, and the writer reports the race instead of
 * overwriting the other source's assertion.
 */
function canonicalWritePremise<T extends object>(
  existing: T,
  policies: readonly CanonicalFieldPolicy<T>[],
): Partial<T> {
  const premise: Partial<T> = {};
  for (const policy of policies) {
    premise[policy.field] = existing[policy.field];
  }
  return premise;
}

function ipToUint32(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    const o = Number(part);
    if (!Number.isInteger(o) || o < 0 || o > 255) return null;
    n = (n * 256 + o) >>> 0;
  }
  return n;
}

// Pure helper — exported for testing.
export function computeUtilization(
  prefix: number,
  occupantIps: string[],
  reservationIps: string[],
): SubnetUtilization {
  const totalUsable = usableHostCount(prefix);
  const claimed = new Set([...occupantIps, ...reservationIps]).size;

  const ipCounts = new Map<string, number>();
  for (const ip of occupantIps) {
    ipCounts.set(ip, (ipCounts.get(ip) ?? 0) + 1);
  }
  let conflictCount = 0;
  for (const count of ipCounts.values()) {
    if (count > 1) conflictCount++;
  }

  return {
    totalUsable,
    claimed: Math.min(claimed, totalUsable),
    free: Math.max(0, totalUsable - claimed),
    conflictCount,
  };
}
