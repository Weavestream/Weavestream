/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { ProseLink } from './ProseLink';

/**
 * NO module mocks, NO providers — deliberately. The mocked suite once
 * masked a real failure here: `RecordLink` used the non-throwing org
 * hook but then called `useScopedNavigate()`, whose `useOrgScope()`
 * throws outside OrgProvider, so an unscoped record link crashed
 * instead of reaching the desktop fallback. This renders the REAL
 * modules bare and pins the graceful path: no scope → desktop anchor,
 * no throw (the navigate hook must not even mount).
 */

const CID = '11111111-1111-1111-1111-111111111111';
const ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

describe('ProseLink outside OrgProvider (real modules)', () => {
  it('renders a record link as a desktop anchor instead of throwing', () => {
    render(
      <ProseLink href={`/admin/companies/${CID}/articles/${ID}`}>
        runbook
      </ProseLink>,
    );
    const a = screen.getByRole('link', { name: 'runbook' });
    expect(a).toHaveAttribute('href', `/admin/companies/${CID}/articles/${ID}`);
    expect(a).toHaveAttribute('target', '_blank');
    expect(a).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('plain and external links keep working bare, as before', () => {
    render(
      <>
        <ProseLink href="https://example.com/x">ext</ProseLink>
        <ProseLink href="#fn-1">note</ProseLink>
      </>,
    );
    expect(screen.getByRole('link', { name: 'ext' })).toHaveAttribute(
      'target',
      '_blank',
    );
    expect(screen.getByRole('link', { name: 'note' })).not.toHaveAttribute(
      'target',
    );
  });
});
