import type { IpReservation, Subnet } from '@prisma/client';
import type {
  IpReservationDto,
  SubnetDetail as SharedSubnetDetail,
  SubnetDto,
  SubnetRow,
} from '@weavestream/shared';
import type { SameShape, WireJson } from '../common/wire-contract.js';
import type { IpamService, SubnetDetail } from './ipam.service.js';

type SubnetListRow = Awaited<
  ReturnType<IpamService['listSubnetsWithUtilization']>
>[number];

// Type-level contracts: the JSON form of each IPAM response type must be
// exactly the shared contract that the web client reads. If either side
// changes alone, a `true` literal below stops type-checking.
describe('IPAM wire contracts', () => {
  it('serializes the Prisma Subnet row to the shared SubnetDto', () => {
    const same: SameShape<WireJson<Subnet>, SubnetDto> = true;
    expect(same).toBe(true);
  });

  it('serializes the subnet list rows to the shared SubnetRow', () => {
    const same: SameShape<WireJson<SubnetListRow>, SubnetRow> = true;
    expect(same).toBe(true);
  });

  it('serializes the Prisma IpReservation row to the shared IpReservationDto', () => {
    const same: SameShape<WireJson<IpReservation>, IpReservationDto> = true;
    expect(same).toBe(true);
  });

  it('serializes SubnetDetail to the shared SubnetDetail', () => {
    const same: SameShape<WireJson<SubnetDetail>, SharedSubnetDetail> = true;
    expect(same).toBe(true);
  });
});
