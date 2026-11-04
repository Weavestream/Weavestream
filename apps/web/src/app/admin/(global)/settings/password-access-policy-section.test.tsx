/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { PasswordAccessPolicy } from '@weavestream/shared';
import { ToastProvider } from '../../../../components/ui';
import { PasswordAccessPolicySection } from './password-access-policy-section';

const apiFetch = jest.fn();
const refresh = jest.fn();

jest.mock('../../../../lib/api', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));
jest.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

const ACTIVE = '00000000-0000-4000-8000-0000000000a1';
const OTHER = '00000000-0000-4000-8000-0000000000a2';
// Saved in the policy, but deactivated since: not in `users` any more.
const GONE = '00000000-0000-4000-8000-0000000000d9';
const ADMIN = '00000000-0000-4000-8000-0000000000f1';

function policy(mode: PasswordAccessPolicy['mode']): PasswordAccessPolicy {
  return {
    mode,
    userIds: [ACTIVE, GONE],
    users: [
      { id: ADMIN, name: 'Admin', email: 'admin@x', role: 'SUPER_ADMIN', alwaysIncluded: true },
      { id: ACTIVE, name: 'Active', email: 'active@x', role: 'OPERATOR', alwaysIncluded: false },
      { id: OTHER, name: 'Other', email: 'other@x', role: 'CONTRACTOR', alwaysIncluded: false },
    ],
  };
}

function renderSection(initial: PasswordAccessPolicy) {
  render(
    <ToastProvider>
      <PasswordAccessPolicySection initial={initial} />
    </ToastProvider>,
  );
}

const saveButton = () => screen.getByRole('button', { name: 'Save password access' });

function sentBody() {
  const [path, init] = apiFetch.mock.calls[0] as [string, { method: string; body: string }];
  expect(path).toBe('/settings/password-access-policy');
  expect(init.method).toBe('PUT');
  return JSON.parse(init.body) as { mode: string; userIds: string[] };
}

beforeEach(() => {
  apiFetch.mockReset().mockResolvedValue({ ok: true, status: 200, data: { ok: true } });
  refresh.mockReset();
});

describe('PasswordAccessPolicySection unavailable users', () => {
  it('blocks the save until unavailable users are removed, then sends only active ids', async () => {
    renderSection(policy('selected_users'));
    fireEvent.click(screen.getByRole('checkbox', { name: /Other/ }));

    expect(screen.getByText(/no\s+longer active internal users/)).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Remove unavailable' }));
    expect(screen.queryByText(/no\s+longer active internal users/)).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.click(saveButton());
    });
    // Never the deactivated id, never the super admin.
    expect(sentBody()).toEqual({ mode: 'selected_users', userIds: [ACTIVE, OTHER].sort() });
    expect(refresh).toHaveBeenCalled();
  });

  it('drops unavailable ids from the kept list when switching to all users', async () => {
    renderSection(policy('selected_users'));
    fireEvent.click(screen.getByRole('radio', { name: /All internal users/ }));
    expect(saveButton()).toBeEnabled();

    await act(async () => {
      fireEvent.click(saveButton());
    });
    expect(sentBody()).toEqual({ mode: 'all_users', userIds: [ACTIVE] });
  });

  it('drops a selected user promoted to super admin, in both modes', async () => {
    // ACTIVE was saved as an operator and is a super admin now.
    const promoted = policy('selected_users');
    promoted.users = promoted.users.map((u) =>
      u.id === ACTIVE ? { ...u, role: 'SUPER_ADMIN', alwaysIncluded: true } : u,
    );
    renderSection({ ...promoted, userIds: [ACTIVE] });
    fireEvent.click(screen.getByRole('radio', { name: /All internal users/ }));
    await act(async () => {
      fireEvent.click(saveButton());
    });
    expect(sentBody()).toEqual({ mode: 'all_users', userIds: [] });

    apiFetch.mockClear();
    fireEvent.click(screen.getByRole('radio', { name: /Selected users only/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Other/ }));
    await act(async () => {
      fireEvent.click(saveButton());
    });
    expect(sentBody()).toEqual({ mode: 'selected_users', userIds: [OTHER] });
  });
});
