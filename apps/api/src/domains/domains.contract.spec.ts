import type {
  DomainAlertDto,
  DomainCheckDto,
  MonitoredDomainDto,
} from '@weavestream/shared';
import type { SameShape, WireJson } from '../common/wire-contract.js';
import type {
  DomainsService,
  SerializedDomainCheck,
  SerializedMonitoredDomain,
} from './domains.service.js';

type DomainAlertRow = Awaited<
  ReturnType<DomainsService['listAlertsAcrossCompanies']>
>[number];

// Type-level contracts: the JSON form of each domain serializer type must be
// exactly the shared contract that the web client reads. If either side
// changes alone, a `true` literal below stops type-checking.
describe('domain wire contracts', () => {
  it('serializes SerializedMonitoredDomain to the shared MonitoredDomainDto', () => {
    const same: SameShape<WireJson<SerializedMonitoredDomain>, MonitoredDomainDto> = true;
    expect(same).toBe(true);
  });

  it('serializes SerializedDomainCheck to the shared DomainCheckDto', () => {
    const same: SameShape<WireJson<SerializedDomainCheck>, DomainCheckDto> = true;
    expect(same).toBe(true);
  });

  it('serializes the alerts feed rows to the shared DomainAlertDto', () => {
    const same: SameShape<WireJson<DomainAlertRow>, DomainAlertDto> = true;
    expect(same).toBe(true);
  });
});
