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

  it('returns nothing for drivers without a page, prototype keys, or an id without the binding prefix', () => {
    expect(sourceRecordUrl('google-workspace', binding('org1:devices:x'))).toBeUndefined();
    expect(sourceRecordUrl('constructor', binding('org1:devices:x'))).toBeUndefined();
    expect(sourceRecordUrl('level', binding(null))).toBeUndefined();
    expect(sourceRecordUrl('level', binding('Z2lkOi8vbGV2ZWwvRGV2aWNlLzE'))).toBeUndefined();
    expect(sourceRecordUrl('level', binding('org1:devices:'))).toBeUndefined();
  });
});
