import { diffRemovedUploadIds, extractEmbeddedUploadIds } from './article-uploads.js';

const ID_A = '11111111-1111-1111-1111-111111111111';
const ID_B = '22222222-2222-2222-2222-222222222222';
const ID_C = '33333333-3333-3333-3333-333333333333';
const COMPANY = '00000000-0000-0000-0000-0000000000aa';

function tiptap(...ids: string[]) {
  return {
    type: 'doc',
    content: ids.map((id) => ({
      type: 'image',
      attrs: { src: `/api/v1/companies/${COMPANY}/uploads/${id}/image` },
    })),
  };
}

describe('extractEmbeddedUploadIds', () => {
  it('returns an empty set for null/undefined/empty bodies', () => {
    expect(extractEmbeddedUploadIds(null).size).toBe(0);
    expect(extractEmbeddedUploadIds(undefined).size).toBe(0);
    expect(extractEmbeddedUploadIds('').size).toBe(0);
    expect(extractEmbeddedUploadIds({}).size).toBe(0);
  });

  it('extracts upload UUIDs from Tiptap image src URLs', () => {
    const ids = extractEmbeddedUploadIds(tiptap(ID_A, ID_B));
    expect(ids).toEqual(new Set([ID_A, ID_B]));
  });

  it('extracts upload UUIDs from Markdown image syntax', () => {
    const md = `Some text\n\n![pic](/api/v1/companies/${COMPANY}/uploads/${ID_A}/image)\n`;
    expect(extractEmbeddedUploadIds(md)).toEqual(new Set([ID_A]));
  });

  it('handles the /blob variant the upload init flow uses', () => {
    const md = `[file](/api/v1/companies/${COMPANY}/uploads/${ID_C}/blob)`;
    expect(extractEmbeddedUploadIds(md)).toEqual(new Set([ID_C]));
  });

  it('lowercases UUIDs so the diff is case-insensitive', () => {
    const upper = ID_A.toUpperCase();
    const md = `/api/v1/companies/${COMPANY}/uploads/${upper}/image`;
    expect(extractEmbeddedUploadIds(md)).toEqual(new Set([ID_A]));
  });

  it('ignores non-upload UUIDs and short-id paths', () => {
    const md = `prefix /api/v1/companies/${COMPANY}/uploads/not-a-uuid/image suffix`;
    expect(extractEmbeddedUploadIds(md).size).toBe(0);
  });
});

describe('diffRemovedUploadIds', () => {
  it('returns ids removed between before and after', () => {
    const removed = diffRemovedUploadIds(
      tiptap(ID_A, ID_B),
      tiptap(ID_A),
    );
    expect(removed).toEqual([ID_B]);
  });

  it('returns no ids when nothing changed', () => {
    expect(diffRemovedUploadIds(tiptap(ID_A), tiptap(ID_A))).toEqual([]);
  });

  it('returns no ids when uploads were added (not removed)', () => {
    expect(diffRemovedUploadIds(tiptap(ID_A), tiptap(ID_A, ID_B))).toEqual([]);
  });

  it('treats null/empty before as no removals', () => {
    expect(diffRemovedUploadIds(null, tiptap(ID_A))).toEqual([]);
  });

  it('returns every previously-embedded id when after is empty', () => {
    expect(diffRemovedUploadIds(tiptap(ID_A, ID_B), null).sort()).toEqual(
      [ID_A, ID_B].sort(),
    );
  });
});
