/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { IpRule } from '../../../../lib/server-api';
import { IpRulesTable } from './ip-rules-table';

const apiFetch = jest.fn();
const toastPush = jest.fn();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), refresh: jest.fn(), replace: jest.fn() }),
}));
jest.mock('../../../../lib/api', () => ({
  apiFetch: (...a: unknown[]) => apiFetch(...a),
}));
// The table, dialog, and banner come through real; only the toast hook
// is stubbed, since no provider is mounted here.
jest.mock('../../../../components/ui', () => {
  const actual = jest.requireActual<typeof import('../../../../components/ui')>(
    '../../../../components/ui',
  );
  return { ...actual, useToast: () => ({ push: toastPush }) };
});

function ipRule(cidr: string, action: IpRule['action'], priority: number, enabled = true): IpRule {
  return {
    id: `rule-${priority}`,
    cidr,
    action,
    note: null,
    priority,
    enabled,
    createdAt: '2026-09-12T00:00:00.000Z',
    updatedAt: '2026-09-12T00:00:00.000Z',
  };
}

function openAddDialog() {
  fireEvent.click(screen.getByRole('button', { name: /add rule/i }));
  return screen.getByPlaceholderText(/2001:db8::\/32/);
}

describe('IpRulesTable', () => {
  beforeEach(() => {
    apiFetch.mockReset();
    toastPush.mockReset();
  });

  it('warns when an IPv4 DENY catch-all has no IPv6 counterpart', () => {
    render(
      <IpRulesTable
        initialRules={[ipRule('203.0.113.0/24', 'ALLOW', 1), ipRule('0.0.0.0/0', 'DENY', 10)]}
      />,
    );
    const warning = screen.getByRole('alert');
    expect(warning).toHaveTextContent('does not apply to IPv6 visitors');
    expect(warning).toHaveTextContent('Add a ::/0 rule');
  });

  it('shows no warning once ::/0 is denied too', () => {
    render(
      <IpRulesTable initialRules={[ipRule('0.0.0.0/0', 'DENY', 10), ipRule('::/0', 'DENY', 11)]} />,
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('does not count a disabled ::/0 rule as the counterpart', () => {
    render(
      <IpRulesTable
        initialRules={[ipRule('0.0.0.0/0', 'DENY', 10), ipRule('::/0', 'DENY', 11, false)]}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('IPv6 visitors');
  });

  it('explains an invalid value in the dialog and keeps Save disabled until it is fixed', () => {
    render(<IpRulesTable initialRules={[]} />);
    const input = openAddDialog();

    fireEvent.change(input, { target: { value: 'fe80::1%eth0' } });
    expect(screen.getByText(/zone ID/)).toBeInTheDocument();
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

    fireEvent.change(input, { target: { value: '2001:DB8::/32' } });
    expect(screen.queryByText(/zone ID/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it("shows the API's reason when a save is refused", async () => {
    apiFetch.mockResolvedValue({
      ok: false,
      status: 400,
      data: null,
      problem: {
        detail: 'This change would block your current IP (2606:4700::1) via rule ::/0.',
      },
    });
    render(<IpRulesTable initialRules={[]} />);
    fireEvent.change(openAddDialog(), { target: { value: '::/0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(toastPush).toHaveBeenCalledWith(
        expect.stringContaining('would block your current IP'),
        'danger',
      ),
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
