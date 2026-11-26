import { formatVersionValue } from './asset-version-format';

const f = (fieldType: string, options: Record<string, unknown> = {}) =>
  ({ fieldType, options }) as never;

describe('formatVersionValue', () => {
  it('returns null for empty values', () => {
    expect(formatVersionValue(f('TEXT'), null)).toBeNull();
    expect(formatVersionValue(f('TEXT'), '')).toBeNull();
    expect(formatVersionValue(f('MULTISELECT'), [])).toBeNull();
    expect(formatVersionValue(f('FILE'), [])).toBeNull();
  });

  it('keeps 0 and false meaningful', () => {
    expect(formatVersionValue(f('NUMBER'), 0)).toBe('0');
    expect(formatVersionValue(f('BOOLEAN'), false)).toBe('No');
  });

  it('labels dropdown and multiselect choices, falling back to the slug', () => {
    const o = { choices: [{ slug: 'prod', label: 'Production' }] };
    expect(formatVersionValue(f('DROPDOWN', o), 'prod')).toBe('Production');
    expect(formatVersionValue(f('MULTISELECT', o), ['prod', 'x'])).toBe('Production, x');
  });

  it('shows counts for opaque ids and file names only for files', () => {
    expect(formatVersionValue(f('TAGS'), ['a', 'b'])).toBe('2 tags');
    expect(formatVersionValue(f('ASSET_REFERENCE'), ['a'])).toBe('1 linked asset');
    expect(
      formatVersionValue(f('FILE'), [{ uploadId: 'u1', filename: 'a.png' }, { uploadId: 'u2' }]),
    ).toBe('a.png');
  });

  it('flattens rich text to text without markup and clips long values', () => {
    const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '<b>hi</b>' }] }] };
    expect(formatVersionValue(f('RICH_TEXT'), doc)).toBe('<b>hi</b>');
    expect(formatVersionValue(f('TEXTAREA'), 'x'.repeat(500))!.length).toBe(401);
  });

  it('prefers a vault link label over its url', () => {
    expect(formatVersionValue(f('VAULTWARDEN_LINK'), { url: 'https://v', label: 'Root' })).toBe('Root');
  });
});
