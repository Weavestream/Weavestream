/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import type { SearchHit } from '@weavestream/shared';
import { fireEvent, render, screen } from '@testing-library/react';
import type { Org } from '../../lib/org-scope';

const navigateMock = jest.fn();
const ORG: Org = { id: 'org-1', name: 'Acme', initials: 'AC', subtitle: null };

let orgScope: {
  currentOrg: Org | null;
  scopeStatus: string;
  retry: () => void;
} = { currentOrg: ORG, scopeStatus: 'ready', retry: jest.fn() };
let me: { role: string } | null = { role: 'TECHNICIAN' };
let results: {
  data?: { items: SearchHit[] };
  isPending: boolean;
  isError: boolean;
  refetch: () => void;
} = { data: undefined, isPending: false, isError: false, refetch: jest.fn() };

jest.mock('../../lib/org-scope', () => ({ useOrgScope: () => orgScope }));
jest.mock('../../screens/TabShell', () => ({ useMe: () => me }));
jest.mock('../../lib/scoped-nav', () => ({
  useScopedNavigate: () => navigateMock,
}));
jest.mock('../../lib/use-back', () => ({ useBackOr: () => jest.fn() }));
jest.mock('../../lib/use-online', () => ({ useOnline: () => true }));
jest.mock('./queries', () => ({
  SEARCH_DEBOUNCE_MS: 200,
  useSearchResults: () => results,
}));
const setDraftMock = jest.fn();
jest.mock('../../components/ask/AskProvider', () => ({
  useAsk: () => ({ setDraft: setDraftMock }),
}));
jest.mock('@tanstack/react-router', () => ({
  useLocation: () => ({ search: {} }),
}));

import { SearchScreen } from './SearchScreen';

function hit(kind: SearchHit['kind'], id: string, title: string): SearchHit {
  return {
    kind,
    id,
    title,
    snippet: `found <mark>pines</mark> here`,
    companyId: ORG.id,
    companyName: ORG.name,
    companySlug: 'acme',
    updatedAt: '2026-07-01T00:00:00.000Z',
    archivedAt: null,
    href: '/admin/never-navigated',
    score: 1,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  orgScope = { currentOrg: ORG, scopeStatus: 'ready', retry: jest.fn() };
  me = { role: 'TECHNICIAN' };
  results = { data: undefined, isPending: false, isError: false, refetch: jest.fn() };
});

describe('SearchScreen', () => {
  it('focuses the field on open — the sanctioned autofocus exception', () => {
    render(<SearchScreen query="" />);
    expect(screen.getByLabelText('Search')).toHaveFocus();
  });

  it('renders grouped results with counts, highlights, and the Ask card', () => {
    results = {
      data: {
        items: [
          hit('password', 'p1', 'Pines router'),
          hit('password', 'p2', 'Pines switch'),
          hit('article', 'a1', 'Pines runbook'),
        ],
      },
      isPending: false,
      isError: false,
      refetch: jest.fn(),
    };
    const { container } = render(<SearchScreen query="pines" />);

    expect(screen.getByText('Passwords · 2')).toBeInTheDocument();
    expect(screen.getByText('Articles · 1')).toBeInTheDocument();
    expect(screen.getByText('Pines router')).toBeInTheDocument();
    // Snippet sentinels became real <mark> elements.
    expect(container.querySelector('mark')).not.toBeNull();
    // The handoff card closes the list.
    expect(
      screen.getByText(/Ask anything about “pines” instead/),
    ).toBeInTheDocument();
    // `total` is always null with hits — no "N results" copy may exist.
    expect(screen.queryByText(/\d+ results/)).toBeNull();
  });

  it('opens a result with upIsBack and the Search back-label', () => {
    results = {
      data: { items: [hit('asset', 's1', 'Pines rack')] },
      isPending: false,
      isError: false,
      refetch: jest.fn(),
    };
    render(<SearchScreen query="pines" />);

    fireEvent.click(screen.getByText('Pines rack'));
    expect(navigateMock).toHaveBeenCalledWith({
      to: '/assets/s1',
      upIsBack: true,
      backLabel: 'Search',
    });
  });

  it('the Ask card prefills the composer draft and opens the overlay', () => {
    results = {
      data: { items: [] },
      isPending: false,
      isError: false,
      refetch: jest.fn(),
    };
    render(<SearchScreen query="pines" />);

    fireEvent.click(screen.getByText(/Ask anything about “pines” instead/));
    expect(setDraftMock).toHaveBeenCalledWith('pines');
    expect(navigateMock).toHaveBeenCalledWith({
      to: '/search',
      search: { q: 'pines', sheet: 'ask' },
    });
  });

  it('shows the org-scoped empty state with the Ask card', () => {
    results = {
      data: { items: [] },
      isPending: false,
      isError: false,
      refetch: jest.fn(),
    };
    render(<SearchScreen query="pines" />);

    expect(screen.getByText('No matches in Acme.')).toBeInTheDocument();
    expect(
      screen.getByText(/Ask anything about “pines” instead/),
    ).toBeInTheDocument();
  });

  it('hides the Ask card for CLIENT_USER — results and empty state alike', () => {
    me = { role: 'CLIENT_USER' };
    results = {
      data: { items: [hit('article', 'a1', 'Public doc')] },
      isPending: false,
      isError: false,
      refetch: jest.fn(),
    };
    const { rerender } = render(<SearchScreen query="pines" />);
    expect(screen.queryByText(/Ask anything about/)).toBeNull();

    results = { data: { items: [] }, isPending: false, isError: false, refetch: jest.fn() };
    rerender(<SearchScreen query="pines" />);
    expect(screen.queryByText(/Ask anything about/)).toBeNull();
  });

  it('shows the scope hint before a query is typed', () => {
    render(<SearchScreen query="" />);
    expect(
      screen.getByText('Searches passwords, assets, and articles in Acme.'),
    ).toBeInTheDocument();
  });
});
