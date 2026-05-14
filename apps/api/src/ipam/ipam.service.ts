import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma, Subnet, IpReservation } from '@prisma/client';
import {
  normalizeCidrV4,
  usableHostCount,
  ipInCidr,
  type CreateSubnetInput,
  type UpdateSubnetInput,
  type CreateIpReservationInput,
  type UpdateIpReservationInput,
} from '@weavestream/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditLogService } from '../audit/audit.service.js';
import { AUDIT_ACTIONS } from '../audit/audit-actions.js';
import type { AuthedUser } from '../common/current-user.decorator.js';

export interface AuditMeta {
  ip: string;
  userAgent: string;
}

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

    return { subnet, utilization, occupants, reservations, conflicts };
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

    const row = await this.prisma.subnet.create({
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

    await this.prisma.subnet.updateMany({
      where: { id, companyId },
      data,
    });
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
    await this.prisma.subnet.updateMany({
      where: { id, companyId },
      data: { archivedAt: null, updatedBy: actor.id },
    });
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
  ): Promise<void> {
    const where: Prisma.SubnetWhereInput = {
      companyId,
      cidr,
      archivedAt: null,
    };
    if (excludeId) where.id = { not: excludeId };
    const dup = await this.prisma.subnet.findFirst({ where });
    if (dup) {
      throw new ConflictException(
        `Subnet ${cidr} already exists for this company`,
      );
    }
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
