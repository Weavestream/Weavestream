import {
  attachmentLabel,
  buildPhotosHref,
  readBool,
  readPhotoQuery,
  readString,
} from './photo-query';

const BASE = '/portal/acme/photos';
const ASSET_ID = '22222222-2222-4222-8222-222222222222';

describe('readString', () => {
  it('returns a non-empty string', () => {
    expect(readString('asset')).toBe('asset');
  });

  it.each([undefined, '', ['a', 'b']])('ignores %p', (v) => {
    expect(readString(v)).toBeUndefined();
  });
});

describe('readBool', () => {
  it.each(['1', 'true', 'TRUE', 'True'])('reads %p as true', (v) => {
    expect(readBool(v)).toBe(true);
  });

  it.each([undefined, '', '0', 'false', 'yes', ['1']])('reads %p as false', (v) => {
    expect(readBool(v)).toBe(false);
  });
});

describe('readPhotoQuery', () => {
  it('reads the shared filters and the cursor', () => {
    expect(
      readPhotoQuery({
        attachedToType: 'asset_field',
        attachedToId: ASSET_ID,
        cursor: 'c1',
      }),
    ).toEqual({ attachedToType: 'asset_field', attachedToId: ASSET_ID, cursor: 'c1' });
  });

  it('never carries includeNonLatest, so the portal cannot forward it', () => {
    const parsed = readPhotoQuery({ includeNonLatest: '1' });
    expect(parsed).not.toHaveProperty('includeNonLatest');
  });
});

describe('buildPhotosHref', () => {
  it('returns the base path with no filters', () => {
    expect(buildPhotosHref(BASE, {})).toBe(BASE);
  });

  it('keeps the id filter when the type pill changes', () => {
    expect(
      buildPhotosHref(BASE, { attachedToType: 'article', attachedToId: ASSET_ID }),
    ).toBe(`${BASE}?attachedToType=article&attachedToId=${ASSET_ID}`);
  });

  it('keeps the id filter on the "All" pill (no type)', () => {
    expect(buildPhotosHref(BASE, { attachedToId: ASSET_ID })).toBe(
      `${BASE}?attachedToId=${ASSET_ID}`,
    );
  });

  it('adds the cursor after the filters for the load-more link', () => {
    expect(
      buildPhotosHref(BASE, {
        attachedToType: 'asset',
        attachedToId: ASSET_ID,
        cursor: 'c2',
      }),
    ).toBe(`${BASE}?attachedToType=asset&attachedToId=${ASSET_ID}&cursor=c2`);
  });

  it('writes includeNonLatest as 1 only when set', () => {
    expect(buildPhotosHref(BASE, { includeNonLatest: true })).toBe(
      `${BASE}?includeNonLatest=1`,
    );
    expect(buildPhotosHref(BASE, { includeNonLatest: false })).toBe(BASE);
  });

  it('encodes a crafted id so it cannot add or override parameters', () => {
    const href = buildPhotosHref(BASE, {
      attachedToType: 'asset',
      attachedToId: 'x&includeNonLatest=1&cursor=evil#frag',
    });
    const url = new URL(href, 'http://localhost');
    expect(url.pathname).toBe(BASE);
    expect(url.hash).toBe('');
    expect([...url.searchParams.keys()]).toEqual(['attachedToType', 'attachedToId']);
    expect(url.searchParams.get('attachedToId')).toBe(
      'x&includeNonLatest=1&cursor=evil#frag',
    );
  });
});

describe('attachmentLabel', () => {
  it.each([
    ['asset', 'Attachment'],
    ['asset_field', 'Asset'],
    ['article', 'Article'],
    ['password', 'password'],
    ['some_type', 'some type'],
  ])('labels %p as %p', (type, label) => {
    expect(attachmentLabel(type)).toBe(label);
  });
});
