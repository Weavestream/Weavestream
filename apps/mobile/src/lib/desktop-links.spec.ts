import { desktopRecordLink } from './desktop-links';

const CID = '11111111-1111-1111-1111-111111111111';
const ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

describe('desktopRecordLink', () => {
  it('maps the three record sections mobile can open', () => {
    expect(desktopRecordLink(`/admin/companies/${CID}/articles/${ID}`)).toEqual({
      companyId: CID,
      to: `/articles/${ID}`,
    });
    expect(desktopRecordLink(`/admin/companies/${CID}/assets/${ID}`)).toEqual({
      companyId: CID,
      to: `/assets/${ID}`,
    });
    expect(desktopRecordLink(`/admin/companies/${CID}/passwords/${ID}`)).toEqual({
      companyId: CID,
      to: `/passwords/${ID}`,
    });
  });

  it('drops query and fragment — mobile detail screens take none', () => {
    expect(
      desktopRecordLink(`/admin/companies/${CID}/articles/${ID}?rev=3#top`),
    ).toEqual({ companyId: CID, to: `/articles/${ID}` });
  });

  it('leaves sections without a mobile screen on desktop', () => {
    expect(desktopRecordLink(`/admin/companies/${CID}/domains/${ID}`)).toBeNull();
    expect(desktopRecordLink(`/admin/companies/${CID}/photos`)).toBeNull();
    expect(desktopRecordLink(`/admin/companies/${CID}`)).toBeNull();
  });

  it('leaves deeper paths (edit, versions) on desktop', () => {
    expect(
      desktopRecordLink(`/admin/companies/${CID}/articles/${ID}/edit`),
    ).toBeNull();
    expect(
      desktopRecordLink(`/admin/companies/${CID}/passwords/${ID}/versions`),
    ).toBeNull();
  });

  it('rejects non-UUID segments — display mapping, not URL guessing', () => {
    expect(desktopRecordLink(`/admin/companies/${CID}/articles/abc`)).toBeNull();
    expect(desktopRecordLink(`/admin/companies/acme/articles/${ID}`)).toBeNull();
  });

  it('ignores portal, external, and unrelated same-origin URLs', () => {
    expect(desktopRecordLink(`/portal/acme/articles/${ID}`)).toBeNull();
    expect(
      desktopRecordLink(`https://example.com/admin/companies/${CID}/articles/${ID}`),
    ).toBeNull();
    expect(desktopRecordLink('/uploads/x/image')).toBeNull();
    expect(desktopRecordLink('/m/articles/abc')).toBeNull();
  });
});
