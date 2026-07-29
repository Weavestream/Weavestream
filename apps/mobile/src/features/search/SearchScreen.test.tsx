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

const switchOrgMock = jest.fn();
jest.mock('../../lib/org-scope', () => ({
  useOrgScope: () => ({ ...orgScope, switchOrg: switchOrgMock, clearOrg: jest.fn() }),
}));
jest.mock('../../screens/TabShell', () => ({ useMe: () => me }));
jest.mock('../../lib/scoped-nav', () => ({
  useScopedNavigate: () => navigateMock,
}));
let backOrTarget: string | undefined;
jest.mock('../../lib/use-back', () => ({
  useBackOr: (to: string) => {
    backOrTarget = to;
    return jest.fn();
  },
}));
jest.mock('../../lib/use-online', () => ({ useOnline: () => true }));
const useSearchResultsMock = jest.fn((..._args: unknown[]) => results);
jest.mock('./queries', () => ({
  SEARCH_DEBOUNCE_MS: 200,
  useSearchResults: (...args: unknown[]) => useSearchResultsMock(...args),
}));
const setDraftMock = jest.fn();
jest.mock('../../components/ask/AskProvider', () => ({
  useAsk: () => ({ setDraft: setDraftMock }),
}));
let locationState: Record<string, unknown> | undefined;
jest.mock('@tanstack/react-router', () => ({
  useLocation: () => ({ search: {}, state: locationState, pathname: '/search' }),
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
  locationState = undefined;
  backOrTarget = undefined;
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

describe('SearchScreen — global mode (null org stamp, Phase 5b)', () => {
  function goGlobal() {
    locationState = { orgId: null };
    orgScope = { currentOrg: null, scopeStatus: 'ready', retry: jest.fn() };
  }

  it('searches with NO companyId and its own idle copy; Done falls back to the launcher', () => {
    goGlobal();
    render(<SearchScreen query="" />);

    expect(
      screen.getByText(
        'Searches passwords, assets, and articles across all your organizations.',
      ),
    ).toBeInTheDocument();
    // First arg is companyId — null in global mode, so the param is omitted.
    expect(useSearchResultsMock).toHaveBeenCalledWith(null, '', { ready: true });
    expect(backOrTarget).toBe('/app');
  });

  it('names each hit’s organization and carries it into the destination on tap', () => {
    goGlobal();
    const cross: SearchHit = {
      ...hit('password', 'p9', 'Fortinet firewall'),
      companyId: 'org-9',
      companyName: 'Northwind MSP',
    };
    results = { data: { items: [cross] }, isPending: false, isError: false, refetch: jest.fn() };

    render(<SearchScreen query="fortinet" />);

    // Org context prominently on the row, and the term highlighted IN
    // the result's own text (no separate snippet line in global mode).
    expect(screen.getByText('Northwind MSP')).toBeInTheDocument();
    const marked = document.querySelector('mark');
    expect(marked).toHaveTextContent('Fortinet');
    expect(screen.queryByText(/found/)).toBeNull(); // the snippet line is gone

    fireEvent.click(screen.getByText('Northwind MSP'));
    expect(switchOrgMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'org-9', name: 'Northwind MSP' }),
    );
    expect(navigateMock).toHaveBeenCalledWith({
      to: '/passwords/p9',
      orgId: 'org-9',
      replace: false,
      upIsBack: true,
      backLabel: 'Search',
    });
  });

  it('a BODY-ONLY global match keeps the server snippet as the evidence', () => {
    goGlobal();
    const bodyHit: SearchHit = {
      ...hit('article', 'a7', 'Runbook'),
      snippet: 'configure the <mark>fortinet</mark> appliance',
      companyId: 'org-9',
      companyName: 'Northwind MSP',
    };
    results = { data: { items: [bodyHit] }, isPending: false, isError: false, refetch: jest.fn() };

    render(<SearchScreen query="fortinet" />);

    // The title shows no occurrence, so the row must still show WHY it
    // matched — the server-highlighted snippet under the company line.
    expect(screen.getByText('Northwind MSP')).toBeInTheDocument();
    expect(screen.getByText('fortinet')).toBeInTheDocument();
    expect(screen.getByText(/configure the/)).toBeInTheDocument();
  });

  it('org mode stays byte-identical: no company line, plain stamped push, /passwords fallback', () => {
    results = {
      data: { items: [hit('password', 'p1', 'Pines router')] },
      isPending: false,
      isError: false,
      refetch: jest.fn(),
    };

    render(<SearchScreen query="pines" />);

    expect(screen.queryByText(ORG.name)).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Pines router'));
    expect(switchOrgMock).not.toHaveBeenCalled();
    expect(navigateMock).toHaveBeenCalledWith({
      to: '/passwords/p1',
      upIsBack: true,
      backLabel: 'Search',
    });
    expect(backOrTarget).toBe('/passwords');
    // Org-mode requests still pin the company and gate on settled scope.
    expect(useSearchResultsMock).toHaveBeenCalledWith('org-1', 'pines', { ready: true });
  });
});
