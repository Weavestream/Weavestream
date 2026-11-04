/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type {
  CompanyMembership,
} from '../../../../../lib/server-api/companies';
import { MembersTable } from './members-table';

const apiFetch = jest.fn();
const toastPush = jest.fn();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), refresh: jest.fn(), replace: jest.fn() }),
}));
jest.mock('../../../../../lib/api', () => ({
  apiFetch: (...a: unknown[]) => apiFetch(...a),
}));
// Pin the desktop branch. `DataTable` renders either the table or the
// cards, never both, so the actions column is only reachable this way.
jest.mock('../../../../../lib/hooks/use-is-mobile', () => ({
  useIsMobile: () => false,
}));
// The invite flow is a full user-creation dialog carrying its own term
// and timezone providers. This suite asks which controls a capability
// yields, so a labelled stub is the honest boundary.
jest.mock('../../../(global)/users/create-user-button', () => ({
  CreateUserButton: ({ triggerLabel }: { triggerLabel: string }) => (
    <button type="button">{triggerLabel}</button>
  ),
}));
jest.mock('../../../../../components/ui', () => {
  const actual =
    jest.requireActual<typeof import('../../../../../components/ui')>(
      '../../../../../components/ui',
    );
  return { ...actual, useToast: () => ({ push: toastPush }) };
});

const rows: CompanyMembership[] = [
  {
    id: 'mem-1',
    role: 'FULL',
    expiresAt: null,
    passwordAccess: 'inherit',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    user: {
      id: 'usr-1',
      email: 'dana@acme.test',
      name: 'Dana Reed',
      role: 'OPERATOR',
      isActive: true,
      mfaEnabled: true,
    },
  },
];

function renderTable(
  caps: { canManage: boolean; canInvite: boolean },
  initial: CompanyMembership[] = rows,
) {
  return render(
    <MembersTable
      companyId="co-1"
      companyName="Acme Corp"
      companySlug="acme-corp"
      companyArchivedAt={null}
      initial={initial}
      {...caps}
    />,
  );
}

const btn = (name: string) => screen.queryByRole('button', { name });

beforeEach(() => {
  jest.clearAllMocks();
});

describe('MembersTable', () => {
  // `membership.read` is satisfied by any effective company access, so
  // the roster itself is never hidden — only the writes are.
  it('shows the roster and no controls without a capability', () => {
    renderTable({ canManage: false, canInvite: false });

    expect(screen.getByText('Dana Reed')).toBeInTheDocument();
    expect(screen.getByText('dana@acme.test')).toBeInTheDocument();
    expect(btn('Edit')).toBeNull();
    expect(btn('Revoke')).toBeNull();
    expect(btn('Add existing user')).toBeNull();
    expect(btn('Invite new user')).toBeNull();
  });

  // Both toolbar buttons reach `/users`, which is USER_MANAGE. Without
  // it the picker and the invite POST return 403, so the whole strip
  // stays down rather than rendering as an empty bordered row.
  it('gives MEMBERSHIP_MANAGE the row actions but not the toolbar', () => {
    renderTable({ canManage: true, canInvite: false });

    expect(btn('Edit')).toBeInTheDocument();
    expect(btn('Revoke')).toBeInTheDocument();
    expect(btn('Add existing user')).toBeNull();
    expect(btn('Invite new user')).toBeNull();
  });

  it('gives both capabilities the full surface', () => {
    renderTable({ canManage: true, canInvite: true });

    expect(btn('Edit')).toBeInTheDocument();
    expect(btn('Revoke')).toBeInTheDocument();
    expect(btn('Add existing user')).toBeInTheDocument();
    expect(btn('Invite new user')).toBeInTheDocument();
  });
});

describe('MembersTable password access', () => {
  const denyRow: CompanyMembership = {
    ...rows[0]!,
    id: 'mem-2',
    passwordAccess: 'deny',
    user: { ...rows[0]!.user, id: 'usr-2', name: 'Lee Park', email: 'lee@acme.test' },
  };

  function openEdit() {
    renderTable({ canManage: true, canInvite: false });
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    return screen.getByRole('dialog');
  }

  function patchBody(): unknown {
    const [path, init] = apiFetch.mock.calls[0] as [string, { method: string; body: string }];
    expect(path).toBe('/memberships/mem-1');
    expect(init.method).toBe('PATCH');
    return JSON.parse(init.body);
  }

  beforeEach(() => {
    apiFetch.mockResolvedValue({ ok: true, data: [] });
  });

  it('shows the override in the Password access column', () => {
    renderTable({ canManage: false, canInvite: false }, [rows[0]!, denyRow]);
    expect(screen.getByRole('columnheader', { name: 'Password access' })).toBeInTheDocument();
    expect(screen.getByText('Deny')).toBeInTheDocument();
    expect(screen.getByText('Global')).toBeInTheDocument();
  });

  it('sends only the role on a role-only edit, so no step-up is asked', async () => {
    const dialog = openEdit();
    const [roleSelect] = within(dialog).getAllByRole('combobox');
    fireEvent.change(roleSelect!, { target: { value: 'READONLY' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(patchBody()).toEqual({ role: 'READONLY' });
  });

  it('sends only the password access when only it changes', async () => {
    const dialog = openEdit();
    fireEvent.change(within(dialog).getByLabelText('Password access'), {
      target: { value: 'allow' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(patchBody()).toEqual({ passwordAccess: 'allow' });
  });

  it('sends no request when nothing changed', async () => {
    const dialog = openEdit();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(apiFetch).not.toHaveBeenCalled();
  });
});
