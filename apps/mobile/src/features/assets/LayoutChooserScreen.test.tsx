/**
 * @jest-environment jsdom
 */
import '@testing-library/jest-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { LayoutChooserScreen } from './LayoutChooserScreen';
import { makeLayout, makeLayoutField } from './test-fixtures';

const navigateMock = jest.fn();
const accessMock = { canWrite: true, isClientUser: false };

jest.mock('../../lib/org-scope', () => ({
  useOrgScope: () => ({
    currentOrg: {
      id: 'c0000000-0000-4000-8000-0000000000c1',
      name: 'Enterprise Title',
      initials: 'ET',
      subtitle: null,
    },
    scopeStatus: 'ready',
    switchOrg: jest.fn(),
    retry: jest.fn(),
  }),
}));
jest.mock('../../lib/scoped-nav', () => ({
  useScopedNavigate: () => navigateMock,
}));
jest.mock('../../lib/use-back', () => ({ useBackOr: () => jest.fn() }));
jest.mock('../../lib/use-company-access', () => ({
  useCompanyAccess: () => accessMock,
}));
jest.mock('../../lib/api', () => {
  const actual = jest.requireActual('../../lib/api');
  return { ...actual, apiFetch: jest.fn() };
});

const { apiFetch } = jest.requireMock('../../lib/api') as { apiFetch: jest.Mock };

const ACTIVE = makeLayout(); // 3 fields, all satisfiable
const DESKTOP_ONLY = makeLayout({
  id: 'd0000000-0000-4000-8000-0000000000d3',
  name: 'Contracts',
  slug: 'contracts',
  fields: [
    makeLayoutField({ slug: 'title', fieldType: 'TEXT', isPrimary: true }),
    makeLayoutField({ slug: 'body', fieldType: 'RICH_TEXT', isRequired: true }),
  ],
});
const ARCHIVED = makeLayout({
  id: 'd0000000-0000-4000-8000-0000000000d4',
  name: 'Retired',
  slug: 'retired',
  archivedAt: '2026-01-01T00:00:00.000Z',
  isActive: false,
});

function renderChooser() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return render(
    <Wrapper>
      <LayoutChooserScreen />
    </Wrapper>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  accessMock.canWrite = true;
  accessMock.isClientUser = false;
  apiFetch.mockResolvedValue({ items: [ACTIVE, DESKTOP_ONLY, ARCHIVED] });
});

describe('LayoutChooserScreen', () => {
  it('lists active layouts with field counts; archived/inactive are excluded', async () => {
    renderChooser();
    expect(await screen.findByRole('button', { name: /Servers/ })).toBeInTheDocument();
    expect(screen.getByText('3 fields')).toBeInTheDocument();
    expect(screen.queryByText('Retired')).not.toBeInTheDocument();
  });

  it('marks layouts with required desktop-only fields but keeps them tappable', async () => {
    renderChooser();
    const row = await screen.findByRole('button', { name: /Contracts/ });
    expect(row).toHaveTextContent('Requires desktop');
    fireEvent.click(row);
    expect(navigateMock).toHaveBeenCalledWith({
      to: '/assets/new',
      search: { layout: DESKTOP_ONLY.id },
      replace: true,
    });
  });

  it('picking a layout REPLACES this entry with the form (never a push, never a fresh upIsBack)', async () => {
    // Load-bearing for the created detail's "‹ Assets" chevron: the
    // create flow must hold ONE stack slot above the list, so the
    // inherited upIsBack stamp pops to the list — a push here made
    // "‹ Assets" return to the chooser (the original 2c bug). A fresh
    // upIsBack stamp would let a cold deep link claim a false parent.
    renderChooser();
    fireEvent.click(await screen.findByRole('button', { name: /Servers/ }));
    expect(navigateMock).toHaveBeenCalledWith({
      to: '/assets/new',
      search: { layout: ACTIVE.id },
      replace: true,
    });
    const call = navigateMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(call).not.toHaveProperty('upIsBack');
  });

  it('shows the empty state when no active layouts exist', async () => {
    apiFetch.mockResolvedValue({ items: [ARCHIVED] });
    renderChooser();
    expect(
      await screen.findByText('No layouts available. Layouts are managed on desktop.'),
    ).toBeInTheDocument();
  });

  it('bounces non-managers back to the list', async () => {
    accessMock.isClientUser = true;
    renderChooser();
    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith({ to: '/assets', replace: true }),
    );
  });
});
