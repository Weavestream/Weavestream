/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import type {
  AssetSummary,
  LayoutFieldSummary,
  LayoutSummary,
} from '../../lib/server-api';
import { LayoutAssetsTable } from './layout-assets-table';

const push = jest.fn();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh: jest.fn(), replace: jest.fn() }),
}));
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({
    href,
    children,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
    href: string;
    children: React.ReactNode;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));
jest.mock('../../lib/timezone-context', () => {
  const Stamp = ({ value }: { value: unknown }) => <span>{String(value)}</span>;
  return { FormattedCalendarDate: Stamp, FormattedDateTime: Stamp };
});

const urlField: LayoutFieldSummary = {
  id: 'f-url',
  name: 'Admin URL',
  slug: 'admin-url',
  fieldType: 'URL',
  position: 1,
  isRequired: false,
  isUniquePerCompany: false,
  visibleToClients: true,
  isPrimary: false,
  showInTable: true,
  options: {},
  archivedAt: null,
};

const layout: LayoutSummary = {
  id: 'l-1',
  name: 'Devices',
  slug: 'devices',
  icon: 'server',
  color: '#3b6ef5',
  isActive: true,
  version: 1,
  position: 0,
  archivedAt: null,
  createdBy: null,
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z',
  fields: [urlField],
};

function makeRow(id: string, name: string, url: string): AssetSummary {
  return {
    id,
    companyId: 'co-1',
    assetLayoutId: layout.id,
    layoutName: layout.name,
    layoutSlug: layout.slug,
    layoutIcon: layout.icon,
    layoutColor: layout.color,
    name,
    externalId: null,
    externalSource: null,
    lastSyncedAt: null,
    syncedFieldIds: [],
    syncSources: [],
    provenance: [],
    archivedAt: null,
    createdBy: null,
    updatedBy: null,
    createdByUser: null,
    updatedByUser: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:00.000Z',
    fieldValues: { 'admin-url': url },
    fields: [],
    references: {},
    isStarred: false,
  };
}

function renderTable(
  rows: AssetSummary[],
  overrides: Partial<
    Pick<
      React.ComponentProps<typeof LayoutAssetsTable>,
      'q' | 'includeArchived' | 'canManage'
    >
  > = {},
) {
  return render(
    <LayoutAssetsTable
      basePath="/admin/companies/co-1"
      layout={layout}
      rows={rows}
      q={overrides.q ?? ''}
      includeArchived={overrides.includeArchived ?? false}
      canManage={overrides.canManage ?? false}
    />,
  );
}

describe('LayoutAssetsTable URL cell', () => {
  // Row-name and "open" cells legitimately contain internal links, so
  // every assertion is scoped to the URL cell's own text node.
  it('links a scheme-less value via safeExternalHref instead of a relative route', () => {
    renderTable([makeRow('a-1', 'Alpha', 'example.com')]);
    const cellLink = screen.getByText('example.com').closest('a');
    expect(cellLink).not.toBeNull();
    expect(cellLink).toHaveAttribute('href', 'https://example.com/');
    expect(cellLink).toHaveAttribute('target', '_blank');
    expect(cellLink).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('never produces a data: link — the value renders as plain text', () => {
    const { container } = renderTable([
      makeRow('a-2', 'Beta', 'data:text/html,hi'),
    ]);
    expect(screen.getByText('data:text/html,hi').closest('a')).toBeNull();
    expect(container.querySelector('a[href^="data:"]')).toBeNull();
  });

  it('renders — for a whitespace-only value, with no anchor', () => {
    renderTable([makeRow('a-3', 'Gamma', '   ')]);
    expect(screen.getByText('—').closest('a')).toBeNull();
  });
});

describe('LayoutAssetsTable filters', () => {
  beforeEach(() => {
    push.mockClear();
  });

  it('keeps filter controls available when a server-side filter has no matches', () => {
    renderTable([], { q: 'missing', includeArchived: true });

    expect(screen.getByPlaceholderText('Search Devices…')).toHaveValue('missing');
    expect(screen.getByRole('button', { name: 'Hide archived' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear filters' })).toBeInTheDocument();
    expect(screen.getByText('No Devices match the current filters.')).toBeInTheDocument();
  });

  it('clears all URL-backed filters without reloading', () => {
    renderTable([], { q: 'missing', includeArchived: true });

    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));

    expect(push).toHaveBeenCalledWith('/admin/companies/co-1/layouts/devices');
  });

  it('synchronizes the search input when URL state changes', () => {
    const { rerender } = renderTable([makeRow('a-4', 'Delta', 'example.com')], {
      q: 'before',
    });

    rerender(
      <LayoutAssetsTable
        basePath="/admin/companies/co-1"
        layout={layout}
        rows={[makeRow('a-4', 'Delta', 'example.com')]}
        q="after"
        includeArchived={false}
        canManage={false}
      />,
    );

    expect(screen.getByPlaceholderText('Search Devices…')).toHaveValue('after');
  });

  it('retains the dedicated creation state for an unfiltered empty layout', () => {
    renderTable([], { canManage: true });

    expect(screen.getByText('No Devices yet for this company.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'New Devices' })).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Search Devices…')).not.toBeInTheDocument();
  });
});
