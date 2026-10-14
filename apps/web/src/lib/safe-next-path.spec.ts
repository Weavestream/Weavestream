import { nextQuery, safeNextPath } from './safe-next-path';

const UID = 'dxD8Ueeeemh4NVcpbl6FiTFOv5P09h5lCSWwz3p2l1M';

describe('safeNextPath', () => {
  it('accepts the consent page for an interaction id', () => {
    expect(safeNextPath(`/oauth/consent/${UID}`)).toBe(`/oauth/consent/${UID}`);
  });

  it.each([
    'https://evil.example/oauth/consent/' + UID,
    '//evil.example/oauth/consent/' + UID,
    '/\\evil.example',
    '\\\\evil.example',
    `/oauth/consent/${UID}/../../admin`,
    `/oauth/consent/../${UID}`,
    `/oauth/consent/${UID}?x=1`,
    `/oauth/consent/${UID}#x`,
    '/oauth/consent/short',
    '/admin',
    '/',
    '',
    'javascript:alert(1)',
  ])('rejects %s', (raw) => {
    expect(safeNextPath(raw)).toBeNull();
  });

  it('rejects non-strings', () => {
    expect(safeNextPath(undefined)).toBeNull();
    expect(safeNextPath(['/oauth/consent/' + UID])).toBeNull();
  });
});

describe('nextQuery', () => {
  it('encodes a valid path and drops anything else', () => {
    expect(nextQuery(`/oauth/consent/${UID}`)).toBe(`?next=${encodeURIComponent(`/oauth/consent/${UID}`)}`);
    expect(nextQuery('//evil.example')).toBe('');
    expect(nextQuery(null)).toBe('');
  });
});
