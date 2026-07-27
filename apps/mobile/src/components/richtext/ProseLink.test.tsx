/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';

const navigateMock = jest.fn();
let orgId: string | null = null;

jest.mock('../../lib/scoped-nav', () => ({
  useScopedNavigate: () => navigateMock,
}));
jest.mock('../../lib/org-scope', () => ({
  useCurrentOrgIdOrNull: () => orgId,
}));

import { ProseLink } from './ProseLink';

const CID = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';
const ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const RECORD_HREF = `/admin/companies/${CID}/articles/${ID}`;

beforeEach(() => {
  jest.clearAllMocks();
  orgId = CID;
});

describe('ProseLink — desktop record URLs (the Ask citation fix)', () => {
  it('re-targets a current-org record link to the mobile screen and navigates in-app', () => {
    render(<ProseLink href={RECORD_HREF}>Reboot runbook</ProseLink>);
    const a = screen.getByRole('link', { name: 'Reboot runbook' });

    // Real href for long-press / open-in-new-tab; no forced new tab.
    expect(a).toHaveAttribute('href', `/m/articles/${ID}`);
    expect(a).not.toHaveAttribute('target');

    fireEvent.click(a);
    expect(navigateMock).toHaveBeenCalledWith({ to: `/articles/${ID}` });
  });

  it('maps assets and passwords the same way', () => {
    render(
      <>
        <ProseLink href={`/admin/companies/${CID}/assets/${ID}`}>rack</ProseLink>
        <ProseLink href={`/admin/companies/${CID}/passwords/${ID}`}>pw</ProseLink>
      </>,
    );
    expect(screen.getByRole('link', { name: 'rack' })).toHaveAttribute(
      'href',
      `/m/assets/${ID}`,
    );
    expect(screen.getByRole('link', { name: 'pw' })).toHaveAttribute(
      'href',
      `/m/passwords/${ID}`,
    );
  });

  it('keeps modified clicks native — navigate is not hijacked', () => {
    render(<ProseLink href={RECORD_HREF}>runbook</ProseLink>);
    fireEvent.click(screen.getByRole('link'), { metaKey: true });
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('leaves a CROSS-org record link on desktop — the mobile screen would 404', () => {
    render(
      <ProseLink href={`/admin/companies/${OTHER}/articles/${ID}`}>
        other org
      </ProseLink>,
    );
    const a = screen.getByRole('link', { name: 'other org' });
    expect(a).toHaveAttribute('href', `/admin/companies/${OTHER}/articles/${ID}`);
    expect(a).toHaveAttribute('target', '_blank');

    fireEvent.click(a);
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('leaves record links on desktop when no org scope is mounted', () => {
    orgId = null;
    render(<ProseLink href={RECORD_HREF}>unscoped</ProseLink>);
    expect(screen.getByRole('link', { name: 'unscoped' })).toHaveAttribute(
      'href',
      RECORD_HREF,
    );
  });

  it('leaves desktop-only sections untouched (regression)', () => {
    render(
      <ProseLink href={`/admin/companies/${CID}/domains/${ID}`}>dom</ProseLink>,
    );
    const a = screen.getByRole('link', { name: 'dom' });
    expect(a).toHaveAttribute('href', `/admin/companies/${CID}/domains/${ID}`);
    expect(a).toHaveAttribute('target', '_blank');
  });
});

describe('ProseLink — existing policy unchanged', () => {
  it('external links open in a new tab with noopener', () => {
    render(<ProseLink href="https://example.com/x">ext</ProseLink>);
    const a = screen.getByRole('link', { name: 'ext' });
    expect(a).toHaveAttribute('href', 'https://example.com/x');
    expect(a).toHaveAttribute('target', '_blank');
    expect(a).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('fragments stay same-tab', () => {
    render(<ProseLink href="#fn-1">note</ProseLink>);
    const a = screen.getByRole('link', { name: 'note' });
    expect(a).toHaveAttribute('href', '#fn-1');
    expect(a).not.toHaveAttribute('target');
  });

  it('rejected hrefs neutralize to plain text', () => {
    render(<ProseLink href={'javascript' + ':alert(1)'}>bad</ProseLink>);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('bad')).toBeInTheDocument();
  });
});
