import { sourceRecordUrl } from './source-urls.js';

const binding = (externalId: string | null) => ({ externalId, externalOrgId: 'org1', resourceKey: 'devices' });

describe('sourceRecordUrl', () => {
  it('builds the Level device page from the source id inside the namespaced binding id', () => {
    expect(sourceRecordUrl('level', binding('org1:devices:Z2lkOi8vbGV2ZWwvRGV2aWNlLzE'))).toBe(
      'https://app.level.io/device/Z2lkOi8vbGV2ZWwvRGV2aWNlLzE/overview',
    );
  });

  it('returns nothing for drivers without a page, prototype keys, or an id without the binding prefix', () => {
    expect(sourceRecordUrl('google-workspace', binding('org1:devices:x'))).toBeUndefined();
    expect(sourceRecordUrl('constructor', binding('org1:devices:x'))).toBeUndefined();
    expect(sourceRecordUrl('level', binding(null))).toBeUndefined();
    expect(sourceRecordUrl('level', binding('Z2lkOi8vbGV2ZWwvRGV2aWNlLzE'))).toBeUndefined();
    expect(sourceRecordUrl('level', binding('org1:devices:'))).toBeUndefined();
  });
});
