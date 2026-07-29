/**
 * @jest-environment jsdom
 */
/**
 * Org-scope resolution.
 *
 * The cases here are the ones that produce silent, wrong behaviour rather
 * than an error: a valid org on page 2 being mistaken for revoked, an
 * archived org being scoped into, a network blip erasing a good
 * preference, and a malformed storage value being sent to the API.
 */
import '@testing-library/jest-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { ApiError } from './api';
import { OrgProvider, clearPersistedOrg, useOrgScope } from './org-scope';

jest.mock('./api', () => {
  class MockApiError extends Error {
    status: number;
    problem: unknown;
    constructor(status: number, problem?: unknown) {
      super(`status ${status}`);
      this.status = status;
      this.problem = problem;
    }
  }
  return { apiFetch: jest.fn(), ApiError: MockApiError };
});

const { apiFetch } = jest.requireMock('./api') as { apiFetch: jest.Mock };

const STORAGE_KEY = 'ws_m_org';
const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

function Probe() {
  const { currentOrg, scopeStatus, switchOrg, clearOrg } = useOrgScope();
  return (
    <div>
      <span data-testid="status">{scopeStatus}</span>
      <span data-testid="org">{currentOrg ? currentOrg.name : 'none'}</span>
      <span data-testid="subtitle">{currentOrg?.subtitle ?? ''}</span>
      <button
        data-testid="clear"
        onClick={() => clearOrg()}
      >
        clear
      </button>
      <button
        data-testid="pick-b"
        onClick={() =>
          switchOrg({ id: ORG_B, name: 'Beta Clinic', initials: 'BC', subtitle: null })
        }
      >
        pick
      </button>
    </div>
  );
}

function renderScope(opts?: { bootOrgFree?: boolean }): { unmount: () => void } {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return render(
    <Wrapper>
      <OrgProvider bootOrgFree={opts?.bootOrgFree}>
        <Probe />
      </OrgProvider>
    </Wrapper>,
  );
}

const company = (over: Record<string, unknown> = {}) => ({
  id: ORG_A,
  name: 'Pinebrook Dental',
  archivedAt: null,
  type: 'CLIENT',
  city: null,
  region: null,
  ...over,
});

beforeEach(() => {
  localStorage.clear();
  apiFetch.mockReset();
});

describe('persisted org validation', () => {
  it('keeps a stored org that validates and is not archived', async () => {
    localStorage.setItem(STORAGE_KEY, ORG_A);
    apiFetch.mockResolvedValueOnce(company({ city: 'Portland', region: 'OR' }));

    renderScope();

    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('ready'),
    );
    expect(screen.getByTestId('org')).toHaveTextContent('Pinebrook Dental');
    expect(screen.getByTestId('subtitle')).toHaveTextContent('Portland, OR');
    expect(apiFetch).toHaveBeenCalledWith(`/companies/${ORG_A}`, {
      signal: expect.anything(),
    });
    // Validated via the detail route, so the list was never consulted.
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it('survives an org that sorts onto a later page of the list', async () => {
    // The bug this prevents: `/companies` is alphabetical with a cursor, so
    // "not in the first page" says nothing about access. Looking for the id
    // in page 1 would silently reset the scope of anyone whose org sorts
    // late. Validation goes through the detail route precisely so
    // pagination is irrelevant.
    localStorage.setItem(STORAGE_KEY, ORG_A);
    apiFetch.mockResolvedValueOnce(company({ name: 'Zenith Manufacturing' }));

    renderScope();

    await waitFor(() =>
      expect(screen.getByTestId('org')).toHaveTextContent('Zenith Manufacturing'),
    );
    expect(localStorage.getItem(STORAGE_KEY)).toBe(ORG_A);
  });

  it('falls back when the stored org is archived, despite a 200', async () => {
    // The detail endpoint returns archived companies with HTTP 200, so
    // status alone is not enough — scoping the app to a decommissioned
    // client would strand the technician there.
    localStorage.setItem(STORAGE_KEY, ORG_A);
    apiFetch
      .mockResolvedValueOnce(company({ archivedAt: '2026-01-01T00:00:00Z' }))
      .mockResolvedValueOnce({ items: [company({ id: ORG_B, name: 'Live Co' })] });

    renderScope();

    await waitFor(() =>
      expect(screen.getByTestId('org')).toHaveTextContent('Live Co'),
    );
    expect(localStorage.getItem(STORAGE_KEY)).toBe(ORG_B);
  });

  it('falls back when the stored org 403s', async () => {
    localStorage.setItem(STORAGE_KEY, ORG_A);
    apiFetch
      .mockRejectedValueOnce(new ApiError(403, null))
      .mockResolvedValueOnce({ items: [company({ id: ORG_B, name: 'Live Co' })] });

    renderScope();

    await waitFor(() =>
      expect(screen.getByTestId('org')).toHaveTextContent('Live Co'),
    );
    expect(localStorage.getItem(STORAGE_KEY)).toBe(ORG_B);
  });

  it('falls back when the stored org 404s', async () => {
    localStorage.setItem(STORAGE_KEY, ORG_A);
    apiFetch
      .mockRejectedValueOnce(new ApiError(404, null))
      .mockResolvedValueOnce({ items: [company({ id: ORG_B, name: 'Live Co' })] });

    renderScope();

    await waitFor(() =>
      expect(screen.getByTestId('org')).toHaveTextContent('Live Co'),
    );
  });

  it('PRESERVES the stored id when validation fails on the network', async () => {
    // A transport failure or a 5xx is not evidence the preference is bad.
    // Erasing it would mean a technician who opened the app in a dead spot
    // came back scoped to a different client.
    localStorage.setItem(STORAGE_KEY, ORG_A);
    apiFetch.mockRejectedValue(new TypeError('Failed to fetch'));

    renderScope();

    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('error'),
    );
    expect(localStorage.getItem(STORAGE_KEY)).toBe(ORG_A);
    expect(screen.getByTestId('org')).toHaveTextContent('none');
  });

  it('PRESERVES the stored id on a 5xx', async () => {
    localStorage.setItem(STORAGE_KEY, ORG_A);
    apiFetch.mockRejectedValue(new ApiError(500, null));

    renderScope();

    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('error'),
    );
    expect(localStorage.getItem(STORAGE_KEY)).toBe(ORG_A);
  });
});

describe('untrusted storage', () => {
  it('clears a malformed stored id WITHOUT issuing a request', async () => {
    // `localStorage` is untrusted input. Interpolating an unvalidated value
    // into `/companies/:id` would send junk to the API to find out it was
    // junk; the shape check answers that locally.
    localStorage.setItem(STORAGE_KEY, 'not-a-uuid');
    apiFetch.mockResolvedValueOnce({ items: [] });

    renderScope();

    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('ready'),
    );
    // Only the fallback list call — never `/companies/not-a-uuid`.
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch).toHaveBeenCalledWith('/companies?limit=1', {
      signal: expect.anything(),
    });
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('rejects a path-traversal-shaped value locally', async () => {
    localStorage.setItem(STORAGE_KEY, '../../admin/companies');
    apiFetch.mockResolvedValueOnce({ items: [] });

    renderScope();

    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('ready'),
    );
    expect(apiFetch).not.toHaveBeenCalledWith(
      expect.stringContaining('admin'),
    );
  });
});

describe('zero-org users', () => {
  it('resolves to ready with a null org rather than erroring', async () => {
    // `GET /companies` returns an empty list by design for a user with no
    // visible companies. That is a real state the UI must render, not a
    // failure and not a redirect loop.
    apiFetch.mockResolvedValueOnce({ items: [] });

    renderScope();

    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('ready'),
    );
    expect(screen.getByTestId('org')).toHaveTextContent('none');
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});

describe('subtitle', () => {
  it('prefers location and falls back to the company type', async () => {
    // Never `{n} sites · {n} passwords` from the mock: no `Site` model
    // exists and no endpoint returns a password count.
    apiFetch.mockResolvedValueOnce({
      items: [company({ city: null, region: null, type: 'VENDOR' })],
    });

    renderScope();

    await waitFor(() =>
      expect(screen.getByTestId('subtitle')).toHaveTextContent('Vendor'),
    );
  });

  it('uses the city alone when there is no region', async () => {
    apiFetch.mockResolvedValueOnce({
      items: [company({ city: 'Leeds', region: null })],
    });

    renderScope();

    await waitFor(() =>
      expect(screen.getByTestId('subtitle')).toHaveTextContent('Leeds'),
    );
  });
});

describe('switching while the initial resolution is still in flight', () => {
  function Switcher() {
    const { currentOrg, scopeStatus, switchOrg } = useOrgScope();
    return (
      <div>
        <span data-testid="status">{scopeStatus}</span>
        <span data-testid="org">{currentOrg ? currentOrg.name : 'none'}</span>
        <button
          type="button"
          onClick={() =>
            switchOrg({
              id: ORG_B,
              name: 'Chosen Co',
              initials: 'CC',
              subtitle: null,
            })
          }
        >
          switch
        </button>
      </div>
    );
  }

  function renderSwitcher() {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <OrgProvider>
          <Switcher />
        </OrgProvider>
      </QueryClientProvider>,
    );
  }

  it('the late resolution must NOT overwrite the chosen org', async () => {
    // The switcher is reachable before scope is `'ready'` — the header
    // renders regardless. If the in-flight resolution is allowed to land
    // after the choice, the UI shows one client while `localStorage` holds
    // another, and the next launch silently disagrees with this one.
    let land: ((row: unknown) => void) | undefined;
    apiFetch.mockImplementation(
      () => new Promise((resolve) => (land = resolve)),
    );

    renderSwitcher();
    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('resolving'),
    );

    fireEvent.click(screen.getByRole('button', { name: 'switch' }));

    await waitFor(() =>
      expect(screen.getByTestId('org')).toHaveTextContent('Chosen Co'),
    );

    // Now let the original request finish, resolving to a *different* org.
    land!({ items: [company({ id: ORG_A, name: 'Alphabetically First' })] });

    // Give any stray resolution a chance to land before asserting.
    await new Promise((r) => setTimeout(r, 20));

    expect(screen.getByTestId('org')).toHaveTextContent('Chosen Co');
    expect(screen.getByTestId('status')).toHaveTextContent('ready');
    expect(localStorage.getItem(STORAGE_KEY)).toBe(ORG_B);
  });

  it('an explicit choice outranks a boot resolution that failed', async () => {
    // The switcher is reachable from the error state's own screen, so this
    // is a real path: having picked an org, the UI must report `'ready'` and
    // show it, not keep insisting the scope is broken.
    localStorage.setItem(STORAGE_KEY, ORG_A);
    apiFetch.mockRejectedValue(new TypeError('Failed to fetch'));

    renderSwitcher();
    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('error'),
    );

    fireEvent.click(screen.getByRole('button', { name: 'switch' }));

    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('ready'),
    );
    expect(screen.getByTestId('org')).toHaveTextContent('Chosen Co');
  });

  it('a 403 that races the switch must NOT clear the new selection', async () => {
    // The old org's validation can reject with a genuine 403 in the same
    // tick the user picks a new one — the response was already in flight
    // when the abort fired. Handling it then would clear the id `switchOrg`
    // has just written, so the UI would show the chosen client while the
    // next launch fell back to the alphabetically-first one.
    localStorage.setItem(STORAGE_KEY, ORG_A);
    let reject: ((err: unknown) => void) | undefined;
    apiFetch.mockImplementation(
      () => new Promise((_resolve, rej) => (reject = rej)),
    );

    renderSwitcher();
    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('resolving'),
    );

    fireEvent.click(screen.getByRole('button', { name: 'switch' }));
    await waitFor(() =>
      expect(localStorage.getItem(STORAGE_KEY)).toBe(ORG_B),
    );

    // The old request now fails with a real terminal error, after the abort.
    reject!(new ApiError(403, null));
    await new Promise((r) => setTimeout(r, 20));

    expect(localStorage.getItem(STORAGE_KEY)).toBe(ORG_B);
    expect(screen.getByTestId('org')).toHaveTextContent('Chosen Co');
    expect(screen.getByTestId('status')).toHaveTextContent('ready');
  });

  it('still clears on a 403 when nothing superseded it', async () => {
    // The guard above must not disable the normal behaviour: an unsuperseded
    // 403 means the stored org is genuinely unusable and has to go.
    localStorage.setItem(STORAGE_KEY, ORG_A);
    apiFetch
      .mockRejectedValueOnce(new ApiError(403, null))
      .mockResolvedValueOnce({ items: [] });

    renderSwitcher();

    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('ready'),
    );
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(screen.getByTestId('org')).toHaveTextContent('none');
  });

  it('aborts the in-flight resolution rather than leaving it running', async () => {
    const signals: (AbortSignal | undefined)[] = [];
    apiFetch.mockImplementation(
      (_path: string, init?: { signal?: AbortSignal }) => {
        signals.push(init?.signal);
        return new Promise(() => {});
      },
    );

    renderSwitcher();
    await waitFor(() => expect(signals.length).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole('button', { name: 'switch' }));

    await waitFor(() => expect(signals[0]?.aborted).toBe(true));
  });
});

describe('clearPersistedOrg', () => {
  it('removes the key', () => {
    localStorage.setItem(STORAGE_KEY, ORG_A);
    clearPersistedOrg();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});

describe('org-free boot (Phase 5b launcher)', () => {
  it('makes ZERO scope requests, reports ready/none, and leaves localStorage alone', async () => {
    localStorage.setItem(STORAGE_KEY, ORG_A);

    renderScope({ bootOrgFree: true });

    expect(screen.getByTestId('status')).toHaveTextContent('ready');
    expect(screen.getByTestId('org')).toHaveTextContent('none');
    // Give any stray fetch a tick to fire, then assert none did.
    await new Promise((r) => setTimeout(r, 0));
    expect(apiFetch).not.toHaveBeenCalled();
    // The persisted preference survives for future scoped deep links.
    expect(localStorage.getItem(STORAGE_KEY)).toBe(ORG_A);
  });

  it('clearOrg leaves org context in memory but keeps the persisted id', async () => {
    localStorage.setItem(STORAGE_KEY, ORG_A);
    apiFetch.mockResolvedValueOnce(company());

    renderScope();
    await waitFor(() =>
      expect(screen.getByTestId('org')).toHaveTextContent('Pinebrook Dental'),
    );

    fireEvent.click(screen.getByTestId('clear'));

    expect(screen.getByTestId('status')).toHaveTextContent('ready');
    expect(screen.getByTestId('org')).toHaveTextContent('none');
    expect(localStorage.getItem(STORAGE_KEY)).toBe(ORG_A);
  });

  it('switchOrg after an org-free boot enters the org and persists it', () => {
    renderScope({ bootOrgFree: true });

    fireEvent.click(screen.getByTestId('pick-b'));

    expect(screen.getByTestId('org')).toHaveTextContent('Beta Clinic');
    expect(localStorage.getItem(STORAGE_KEY)).toBe(ORG_B);
  });
});
