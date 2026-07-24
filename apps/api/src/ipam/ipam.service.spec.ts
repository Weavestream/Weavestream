import { ConflictException } from '@nestjs/common';
import { computeUtilization, IpamService } from './ipam.service.js';
import {
  normalizeCidrV4,
  usableHostCount,
  ipInCidr,
} from '@weavestream/shared';

describe('normalizeCidrV4', () => {
  it('normalises host bits to the network address', () => {
    expect(normalizeCidrV4('10.0.0.5/24')).toBe('10.0.0.0/24');
    expect(normalizeCidrV4('192.168.1.137/25')).toBe('192.168.1.128/25');
  });

  it('returns null for invalid input', () => {
    expect(normalizeCidrV4('not-a-cidr')).toBeNull();
    expect(normalizeCidrV4('10.0.0.1')).toBeNull(); // missing prefix
    expect(normalizeCidrV4('10.0.0.1/33')).toBeNull(); // prefix too large
    expect(normalizeCidrV4('999.0.0.0/8')).toBeNull(); // invalid octet
  });

  it('handles /0 and /32 edge cases', () => {
    expect(normalizeCidrV4('0.0.0.0/0')).toBe('0.0.0.0/0');
    expect(normalizeCidrV4('10.0.0.5/32')).toBe('10.0.0.5/32');
  });

  it('preserves already-canonical forms', () => {
    expect(normalizeCidrV4('172.16.0.0/12')).toBe('172.16.0.0/12');
  });
});

describe('usableHostCount', () => {
  it('returns 254 for /24', () => {
    expect(usableHostCount(24)).toBe(254);
  });

  it('returns 2 for /30', () => {
    expect(usableHostCount(30)).toBe(2);
  });

  it('returns 2 for /31 (RFC 3021)', () => {
    expect(usableHostCount(31)).toBe(2);
  });

  it('returns 1 for /32', () => {
    expect(usableHostCount(32)).toBe(1);
  });

  it('returns large counts for wide prefixes', () => {
    expect(usableHostCount(16)).toBe(65534);
    expect(usableHostCount(8)).toBe(16777214);
  });
});

describe('ipInCidr', () => {
  it('returns true when the IP is inside the subnet', () => {
    expect(ipInCidr('10.0.0.5', '10.0.0.0/24')).toBe(true);
    expect(ipInCidr('192.168.1.200', '192.168.1.128/25')).toBe(true);
  });

  it('returns false when the IP is outside the subnet', () => {
    expect(ipInCidr('10.0.1.5', '10.0.0.0/24')).toBe(false);
    expect(ipInCidr('192.168.1.10', '192.168.1.128/25')).toBe(false);
  });

  it('handles edge cases', () => {
    expect(ipInCidr('10.0.0.5', '10.0.0.5/32')).toBe(true);
    expect(ipInCidr('10.0.0.6', '10.0.0.5/32')).toBe(false);
    expect(ipInCidr('0.0.0.0', '0.0.0.0/0')).toBe(true);
  });
});

describe('computeUtilization', () => {
  it('counts unique IPs across occupants and reservations', () => {
    const result = computeUtilization(
      24,
      ['10.0.0.1', '10.0.0.2', '10.0.0.3'],
      ['10.0.0.1', '10.0.0.10'],
    );
    expect(result.totalUsable).toBe(254);
    // Unique IPs: 10.0.0.1, .2, .3, .10 = 4
    expect(result.claimed).toBe(4);
    expect(result.free).toBe(250);
    expect(result.conflictCount).toBe(0);
  });

  it('detects conflicts when occupants share an IP', () => {
    const result = computeUtilization(
      24,
      ['10.0.0.1', '10.0.0.1', '10.0.0.2'],
      [],
    );
    expect(result.conflictCount).toBe(1);
    expect(result.claimed).toBe(2);
  });

  it('handles empty lists', () => {
    const result = computeUtilization(24, [], []);
    expect(result.totalUsable).toBe(254);
    expect(result.claimed).toBe(0);
    expect(result.free).toBe(254);
    expect(result.conflictCount).toBe(0);
  });

  it('caps claimed at totalUsable', () => {
    // /30 has 2 usable addresses — add 3 to test capping
    const result = computeUtilization(30, ['10.0.0.1', '10.0.0.2', '10.0.0.3'], []);
    expect(result.totalUsable).toBe(2);
    expect(result.claimed).toBe(2);
    expect(result.free).toBe(0);
  });

  it('handles /32 correctly', () => {
    const result = computeUtilization(32, ['10.0.0.5'], []);
    expect(result.totalUsable).toBe(1);
    expect(result.claimed).toBe(1);
    expect(result.free).toBe(0);
  });
});

describe('canonical CIDR write races', () => {
  const actor = { id: '51000000-0000-0000-0000-000000000002' };
  const companyId = '51000000-0000-0000-0000-000000000001';
  const subnetId = '51000000-0000-0000-0000-000000000004';
  const meta = { ip: '127.0.0.1', userAgent: 'jest' };
  const uniqueError = () => Object.assign(new Error('unique'), { code: 'P2002' });
  const subnet = (archivedAt: Date | null = null) => ({
    id: subnetId,
    companyId,
    name: 'LAN',
    cidr: '10.0.0.0/24',
    prefix: 24,
    vlanId: null,
    gateway: null,
    dhcpRangeStart: null,
    dhcpRangeEnd: null,
    description: null,
    archivedAt,
    createdBy: actor.id,
    updatedBy: actor.id,
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    updatedAt: new Date('2026-07-01T00:00:00.000Z'),
  });

  it('maps a create race lost at the canonical unique index to ConflictException', async () => {
    const prisma = {
      subnet: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockRejectedValue(uniqueError()),
      },
    };
    const service = new IpamService(prisma as never, { log: jest.fn() } as never);

    await expect(service.createSubnet(
      actor as never,
      companyId,
      { name: 'LAN', cidr: '10.0.0.42/24' },
      meta,
    )).rejects.toBeInstanceOf(ConflictException);
  });

  it('maps update and restore races lost at the canonical unique index to ConflictException', async () => {
    const active = subnet();
    const updatePrisma = {
      subnet: {
        findFirst: jest.fn()
          .mockResolvedValueOnce(active)
          .mockResolvedValueOnce(null),
        updateMany: jest.fn().mockRejectedValue(uniqueError()),
      },
    };
    const updateService = new IpamService(updatePrisma as never, { log: jest.fn() } as never);
    await expect(updateService.updateSubnet(
      actor as never,
      companyId,
      subnetId,
      { cidr: '10.1.0.42/24' },
      meta,
    )).rejects.toBeInstanceOf(ConflictException);

    const archived = subnet(new Date('2026-07-02T00:00:00.000Z'));
    const restorePrisma = {
      subnet: {
        findFirst: jest.fn()
          .mockResolvedValueOnce(archived)
          .mockResolvedValueOnce(null),
        updateMany: jest.fn().mockRejectedValue(uniqueError()),
      },
    };
    const restoreService = new IpamService(restorePrisma as never, { log: jest.fn() } as never);
    await expect(restoreService.restoreSubnet(
      actor as never,
      companyId,
      subnetId,
      meta,
    )).rejects.toBeInstanceOf(ConflictException);
  });
});
