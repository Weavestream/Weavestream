import { sourceRecordUrl } from './source-urls.js';

const binding = (externalId: string | null) => ({ externalId, externalOrgId: 'org1', resourceKey: 'devices' });

describe('sourceRecordUrl', () => {
  it('builds the Level device page from the source id inside the namespaced binding id', () => {
    expect(sourceRecordUrl('level', binding('org1:devices:Z2lkOi8vbGV2ZWwvRGV2aWNlLzE'))).toBe(
      'https://app.level.io/device/Z2lkOi8vbGV2ZWwvRGV2aWNlLzE/overview',
    );
  });

  describe('Action1', () => {
    const org = '0d1c8d70-83e1-11ef-8ff3-b7b4c2126c06';
    const endpoint = 'f91533d9-1500-49f5-ab1e-25a6b0cad42c';
    const a1 = (config?: unknown, externalId = `${org}:records:${endpoint}`) =>
      sourceRecordUrl('action1', { externalId, externalOrgId: org, resourceKey: 'records', config });

    it('builds the endpoint page on the default host when no base URL is set', () => {
      const expected = `https://app.action1.com/console/endpoints/${endpoint}/general?org=${org}`;
      expect(a1(undefined)).toBe(expected);
      expect(a1({})).toBe(expected);
      expect(a1({ baseUrl: 'https://app.action1.com/api/3.0' })).toBe(expected);
    });

    it('uses the console host of the configured region', () => {
      expect(a1({ baseUrl: 'https://app.eu.action1.com/api/3.0/' })).toBe(
        `https://app.eu.action1.com/console/endpoints/${endpoint}/general?org=${org}`,
      );
      expect(a1({ baseUrl: 'https://APP.AU.action1.com/api/3.0' })).toBe(
        `https://app.au.action1.com/console/endpoints/${endpoint}/general?org=${org}`,
      );
    });

    it('gives no link for a host outside the known regions or a malformed base URL', () => {
      expect(a1({ baseUrl: 'https://evil.example/api/3.0' })).toBeUndefined();
      expect(a1({ baseUrl: 'https://app.action1.com.evil.example/api/3.0' })).toBeUndefined();
      expect(a1({ baseUrl: 'http://app.action1.com/api/3.0' })).toBeUndefined();
      expect(a1({ baseUrl: 'not a url' })).toBeUndefined();
      expect(a1({ baseUrl: 42 })).toBeUndefined();
    });

    it('encodes the ids it puts into the URL', () => {
      const url = a1(undefined, `${org}:records:a/b?c`);
      expect(url).toBe(`https://app.action1.com/console/endpoints/a%2Fb%3Fc/general?org=${org}`);
    });
  });

  describe('NinjaOne', () => {
    const n1 = (config?: unknown, externalId = '4:records:44', resourceKey = 'records', sourceKind: string | null = null) =>
      sourceRecordUrl('ninjaone', { externalId, externalOrgId: '4', resourceKey, sourceKind, config });
    const other = (id: number, sourceKind: string | null) => n1(undefined, `4:nms:${id}`, 'nms', sourceKind);

    it('builds the device dashboard on the default host when no base URL is set', () => {
      const expected = 'https://app.ninjarmm.com/#/deviceDashboard/44/overview';
      expect(n1(undefined)).toBe(expected);
      expect(n1({})).toBe(expected);
      expect(n1({ baseUrl: 'https://app.ninjarmm.com/' })).toBe(expected);
    });

    it('links agent devices to the device dashboard whatever their node class', () => {
      expect(n1(undefined, '4:records:44', 'records', 'WINDOWS_SERVER')).toBe('https://app.ninjarmm.com/#/deviceDashboard/44/overview');
    });

    it.each([
      ['NMS_OTHER', 63, 'nmsDashboard'],
      ['NMS_FIREWALL', 90, 'nmsDashboard'],
      ['HYPERV_VMM_HOST', 74, 'vmDashboard'],
      ['VMWARE_VM_HOST', 75, 'vmDashboard'],
      ['HYPERV_VMM_GUEST', 85, 'vmGuestDashboard'],
      ['VMWARE_VM_GUEST', 86, 'vmGuestDashboard'],
      ['CLOUD_MONITOR_TARGET', 72, 'cloudMonitorDashboard'],
    ])('links a %s device to its own dashboard page', (nodeClass, id, page) => {
      expect(other(id, nodeClass)).toBe(`https://app.ninjarmm.com/#/${page}/${id}/overview`);
    });

    it('gives no link for a non-agent device with no stored or no known node class', () => {
      expect(other(109, null)).toBeUndefined();
      expect(other(109, 'WINDOWS_SERVER')).toBeUndefined();
      expect(other(109, 'SOMETHING_NEW')).toBeUndefined();
    });

    it('uses the web app host of the configured instance', () => {
      expect(n1({ baseUrl: 'https://eu.ninjarmm.com' })).toBe('https://eu.ninjarmm.com/#/deviceDashboard/44/overview');
      expect(n1({ baseUrl: 'https://FED.ninjarmm.com' })).toBe('https://fed.ninjarmm.com/#/deviceDashboard/44/overview');
    });

    it('gives no link for a host outside the known instances or a malformed base URL', () => {
      expect(n1({ baseUrl: 'https://evil.example' })).toBeUndefined();
      expect(n1({ baseUrl: 'https://app.ninjarmm.com.evil.example' })).toBeUndefined();
      expect(n1({ baseUrl: 'http://app.ninjarmm.com' })).toBeUndefined();
      expect(n1({ baseUrl: 'not a url' })).toBeUndefined();
      expect(n1({ baseUrl: 42 })).toBeUndefined();
    });

    it('encodes the id it puts into the URL', () => {
      expect(n1(undefined, '4:records:a/b#c')).toBe('https://app.ninjarmm.com/#/deviceDashboard/a%2Fb%23c/overview');
    });
  });

  it('returns nothing for drivers without a page, prototype keys, or an id without the binding prefix', () => {
    expect(sourceRecordUrl('google-workspace', binding('org1:devices:x'))).toBeUndefined();
    expect(sourceRecordUrl('constructor', binding('org1:devices:x'))).toBeUndefined();
    expect(sourceRecordUrl('level', binding(null))).toBeUndefined();
    expect(sourceRecordUrl('level', binding('Z2lkOi8vbGV2ZWwvRGV2aWNlLzE'))).toBeUndefined();
    expect(sourceRecordUrl('level', binding('org1:devices:'))).toBeUndefined();
  });
});
