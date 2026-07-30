/**
 * @jest-environment jsdom
 */
import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import type { Me } from '../../screens/TabShell';
import { ProfileScreen } from './ProfileScreen';

const navigateMock = jest.fn();

jest.mock('../../lib/scoped-nav', () => ({ useScopedNavigate: () => navigateMock }));
jest.mock('../../components/DetailHeader', () => ({
  DetailHeader: ({ backLabel }: { backLabel: string }) => (
    <header>{`back:${backLabel}`}</header>
  ),
}));
// The sheet's own ordering contract is covered by AppearanceSheet.test.tsx;
// here we only care that this screen is what opens it.
jest.mock('../../components/AppearanceSheet', () => ({
  AppearanceSheet: ({ open }: { open: boolean }) =>
    open ? <div role="dialog">Appearance</div> : null,
}));

let me: Me | null;
jest.mock('../../screens/TabShell', () => ({ useMe: () => me }));

function operatorMe(over: Partial<Me> = {}): Me {
  return {
    id: 'u1',
    email: 'tech@example.com',
    name: 'Ada Lovelace',
    role: 'OPERATOR',
    globalAccess: 'NONE',
    platformCapabilities: [],
    memberships: [],
    ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  me = operatorMe();
});

describe('ProfileScreen', () => {
  it('shows identity as inert context, not an editable row', () => {
    render(<ProfileScreen />);

    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.getByText(/tech@example\.com/)).toBeInTheDocument();
    // Only Appearance and Change password are actionable — identity is
    // context by decision (email has no change path at all, and a name-only
    // form did not earn a screen).
    const buttons = screen.getAllByRole('button').map((b) => b.textContent);
    expect(buttons).toEqual(['Appearance', 'Change password']);
  });

  it('opens the shipped Appearance sheet rather than a second implementation', () => {
    render(<ProfileScreen />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Appearance' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('pushes the change-password form with a labelled back target', () => {
    render(<ProfileScreen />);
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));

    expect(navigateMock).toHaveBeenCalledWith({
      to: '/profile/password',
      upIsBack: true,
      backLabel: 'Profile',
    });
  });

  it('backs out to More', () => {
    render(<ProfileScreen />);
    expect(screen.getByText('back:More')).toBeInTheDocument();
  });

  it('falls back to the email when the account has no name', () => {
    me = operatorMe({ name: null });
    render(<ProfileScreen />);

    expect(screen.getAllByText(/tech@example\.com/)).toHaveLength(1);
  });
});
