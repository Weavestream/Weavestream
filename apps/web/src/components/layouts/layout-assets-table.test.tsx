/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type {
  AssetSummary,
  LayoutFieldSummary,
  LayoutSummary,
} from '@weavestream/shared';
import { LayoutAssetsTable } from './layout-assets-table';
import { TimezoneProvider } from '../../lib/timezone-context';

const push = jest.fn();
const replace = jest.fn();

/**
 * `useTransition` runs the callback at once and reports `navigating` as
 * its pending flag. With the flag true, the table sees a navigation
 * still in flight, as Next reports until a pushed URL lands.
 */
const mockTransition = { navigating: false };
jest.mock('react', () => ({
  ...jest.requireActual<typeof import('react')>('react'),
  useTransition: () => [mockTransition.navigating, (fn: () => void) => fn()],
}));

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh: jest.fn(), replace }),
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
  // Keep the real provider, `useTimezone` and `FormattedFieldDateTime`: the
  // DATETIME sort test depends on the viewer's zone.
  return {
    ...jest.requireActual('../../lib/timezone-context'),
    FormattedCalendarDate: Stamp,
    FormattedDateTime: Stamp,
  };
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
      'searchTerms' | 'includeArchived' | 'canManage'
    >
  > = {},
) {
  return render(
    <LayoutAssetsTable
      basePath="/admin/companies/co-1"
      layout={layout}
      rows={rows}
      searchTerms={overrides.searchTerms ?? []}
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
    replace.mockClear();
  });

  it('keeps filter controls available when a server-side filter has no matches', () => {
    renderTable([], { searchTerms: ['missing'], includeArchived: true });

    expect(screen.getByPlaceholderText('Add a search term…')).toHaveValue('');
    expect(screen.getByText('search: missing')).toBeInTheDocument();
    expect(screen.getByText('incl. archived')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hide archived' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'clear all' })).toBeInTheDocument();
    expect(screen.getByText('No Devices match the current filters.')).toBeInTheDocument();
  });

  it('clears all URL-backed filters without reloading', () => {
    renderTable([], { searchTerms: ['missing'], includeArchived: true });

    fireEvent.click(screen.getByRole('button', { name: 'clear all' }));

    expect(push).toHaveBeenCalledWith('/admin/companies/co-1/layouts/devices');
  });

  it('stacks a new search term as a pill and clears the box (#99)', () => {
    renderTable([makeRow('a-1', 'Alpha', 'example.com')], { searchTerms: ['dell'] });
    const box = screen.getByPlaceholderText('Add a search term…');

    fireEvent.change(box, { target: { value: ' 10.2.4 ' } });
    fireEvent.keyDown(box, { key: 'Enter' });

    // An added term edits the active search: it replaces the history
    // entry, so Back removes the whole search.
    expect(replace).toHaveBeenCalledWith('/admin/companies/co-1/layouts/devices?q=dell&q=10.2.4');
    expect(push).not.toHaveBeenCalled();
    expect(box).toHaveValue('');
  });

  it('ignores a blank or repeated term and never commits on blur', () => {
    renderTable([makeRow('a-1', 'Alpha', 'example.com')], { searchTerms: ['dell'] });
    const box = screen.getByPlaceholderText('Add a search term…');

    fireEvent.change(box, { target: { value: 'DELL' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    fireEvent.change(box, { target: { value: '   ' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    fireEvent.change(box, { target: { value: 'typed only' } });
    fireEvent.blur(box);

    expect(push).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it('removes one search pill and keeps the others', () => {
    renderTable([makeRow('a-1', 'Alpha', 'example.com')], {
      searchTerms: ['dell', 'lab', 'rack 4'],
      includeArchived: true,
    });

    const pill = screen.getByText('search: lab').closest('span')!;
    fireEvent.click(within(pill).getByRole('button', { name: 'Remove filter' }));

    expect(replace).toHaveBeenCalledWith(
      '/admin/companies/co-1/layouts/devices?q=dell&q=rack+4&archived=1',
    );
  });

  it('keeps a term entered while the previous search is still navigating', () => {
    // Next keeps the push transition pending until the new URL lands, so
    // the URL (the `searchTerms` prop) still has no terms here.
    mockTransition.navigating = true;
    try {
      renderTable([makeRow('a-1', 'Alpha', 'example.com')]);
      const box = screen.getByPlaceholderText('Search Devices…');

      fireEvent.change(box, { target: { value: 'dell' } });
      fireEvent.keyDown(box, { key: 'Enter' });
      fireEvent.change(box, { target: { value: 'lab' } });
      fireEvent.keyDown(box, { key: 'Enter' });

      // The 1st term starts the search (a new history entry); the 2nd
      // edits it (replaces that entry).
      expect(push).toHaveBeenCalledTimes(1);
      expect(push).toHaveBeenCalledWith('/admin/companies/co-1/layouts/devices?q=dell');
      expect(replace).toHaveBeenLastCalledWith('/admin/companies/co-1/layouts/devices?q=dell&q=lab');
      expect(screen.getByText('search: dell')).toBeInTheDocument();
      expect(screen.getByText('search: lab')).toBeInTheDocument();
    } finally {
      mockTransition.navigating = false;
    }
  });

  it('forgets pushed terms once navigation settles, so a later navigation cannot bring them back', () => {
    const rows = [makeRow('a-1', 'Alpha', 'example.com')];
    const table = (navigating: boolean) => {
      mockTransition.navigating = navigating;
      return (
        <LayoutAssetsTable
          basePath="/admin/companies/co-1"
          layout={layout}
          rows={rows}
          searchTerms={[]}
          includeArchived={false}
          canManage={false}
        />
      );
    };
    try {
      // Search for `dell` while a navigation is in flight.
      const { rerender } = render(table(true));
      const box = screen.getByPlaceholderText('Search Devices…');
      fireEvent.change(box, { target: { value: 'dell' } });
      fireEvent.keyDown(box, { key: 'Enter' });
      expect(screen.getByText('search: dell')).toBeInTheDocument();

      // Navigation settles; then Back leaves a URL with no terms.
      rerender(table(false));
      // A later navigation (for example removing another pill) starts.
      rerender(table(true));

      expect(screen.queryByText('search: dell')).not.toBeInTheDocument();
      fireEvent.change(box, { target: { value: 'lab' } });
      fireEvent.keyDown(box, { key: 'Enter' });
      expect(push).toHaveBeenLastCalledWith('/admin/companies/co-1/layouts/devices?q=lab');
    } finally {
      mockTransition.navigating = false;
    }
  });

  it('follows the URL again once navigation settles', () => {
    renderTable([makeRow('a-1', 'Alpha', 'example.com')]);
    const box = screen.getByPlaceholderText('Search Devices…');

    // The mocked push never changes the URL and the transition is not
    // pending, so the URL's empty term list is what the next push uses.
    fireEvent.change(box, { target: { value: 'dell' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    fireEvent.change(box, { target: { value: 'lab' } });
    fireEvent.keyDown(box, { key: 'Enter' });

    expect(push).toHaveBeenLastCalledWith('/admin/companies/co-1/layouts/devices?q=lab');
  });

  it('removes the last search pill on Backspace in an empty box', () => {
    renderTable([makeRow('a-1', 'Alpha', 'example.com')], { searchTerms: ['dell', 'lab'] });

    fireEvent.keyDown(screen.getByPlaceholderText('Add a search term…'), { key: 'Backspace' });

    expect(replace).toHaveBeenCalledWith('/admin/companies/co-1/layouts/devices?q=dell');
  });

  it('retains the dedicated creation state for an unfiltered empty layout', () => {
    renderTable([], { canManage: true });

    expect(screen.getByText('No Devices yet for this company.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'New Devices' })).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Search Devices…')).not.toBeInTheDocument();
  });
});

describe('LayoutAssetsTable DATETIME sorting', () => {
  // Issue #98 review: a zone-less value is wall-clock time and an instant
  // shows in the viewer's zone, so the sort must follow the displayed time.
  // For a Los Angeles viewer `20:00Z` shows as 01:00 PM and must sort before
  // the zone-less `15:00` (03:00 PM), although it is the later instant.
  const whenField: LayoutFieldSummary = {
    ...urlField,
    id: 'f-when',
    name: 'Installed',
    slug: 'installed',
    fieldType: 'DATETIME',
    position: 2,
  };
  const whenLayout: LayoutSummary = { ...layout, fields: [urlField, whenField] };

  function whenRow(id: string, name: string, installed: string): AssetSummary {
    const row = makeRow(id, name, 'example.com');
    return { ...row, fieldValues: { ...row.fieldValues, installed } };
  }

  function displayedTimes(): string[] {
    return screen
      .getAllByText(/^Jul 1, 2026, /)
      .map((el) => el.textContent ?? '');
  }

  it('sorts mixed zone-less and zoned values in displayed order', () => {
    render(
      <TimezoneProvider timezone="America/Los_Angeles">
        <LayoutAssetsTable
          basePath="/admin/companies/co-1"
          layout={whenLayout}
          rows={[
            whenRow('a-1', 'Wall clock', '2026-07-01T15:00'),
            whenRow('a-2', 'Instant', '2026-07-01T20:00:00Z'),
            whenRow('a-3', 'Earlier wall clock', '2026-07-01T14:59'),
          ]}
          searchTerms={[]}
          includeArchived={false}
          canManage={false}
        />
      </TimezoneProvider>,
    );

    const header = screen.getByRole('columnheader', { name: /Installed/ });
    fireEvent.click(within(header).getByRole('button'));
    expect(header).toHaveAttribute('aria-sort', 'ascending');
    expect(displayedTimes()).toEqual([
      'Jul 1, 2026, 01:00 PM',
      'Jul 1, 2026, 02:59 PM',
      'Jul 1, 2026, 03:00 PM',
    ]);

    fireEvent.click(within(header).getByRole('button'));
    expect(header).toHaveAttribute('aria-sort', 'descending');
    expect(displayedTimes()).toEqual([
      'Jul 1, 2026, 03:00 PM',
      'Jul 1, 2026, 02:59 PM',
      'Jul 1, 2026, 01:00 PM',
    ]);
  });
});
