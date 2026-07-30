/**
 * @jest-environment jsdom
 */
import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import type { Me } from './TabShell';
import { MoreTab } from './MoreTab';

/**
 * Phase 5c reshaped this screen twice over, and both changes have a failure
 * mode a reader would not predict:
 *
 *  - The identity card was captioned "profile" with nothing behind it. It is
 *    now the way into `/profile`.
 *  - Appearance moved to that profile screen, which left `Install app` alone
 *    in the `App` group — and that row is itself conditional, absent exactly
 *    when the app is already installed. So the whole group has to disappear,
 *    or every installed user sees a labelled empty box. That is the primary
 *    configuration, not an edge case.
 */

const navigateMock = jest.fn();
const openOrgSheet = jest.fn();
let me: Me | null;
let standalone: boolean;
let canPrompt: boolean;
let iosTarget: boolean;

jest.mock('../lib/scoped-nav', () => ({ useScopedNavigate: () => navigateMock }));
jest.mock('./TabShell', () => ({
  useMe: () => me,
  useOpenOrgSheet: () => openOrgSheet,
}));
jest.mock('../lib/sign-out', () => ({ signOutAndReset: jest.fn() }));
jest.mock('../lib/install-prompt', () => ({
  subscribeInstallAvailability: () => () => {},
  isStandalone: () => standalone,
  canPromptInstall: () => canPrompt,
  isIosSafariInstallTarget: () => iosTarget,
  promptInstall: jest.fn(),
}));

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
  // Default to the browser-with-an-install-prompt case; the installed case
  // is set explicitly where it matters.
  standalone = false;
  canPrompt = true;
  iosTarget = false;
});

describe('MoreTab', () => {
  it('opens the profile from the identity card', () => {
    render(<MoreTab />);

    fireEvent.click(screen.getByRole('button', { name: /Ada Lovelace/ }));
    expect(navigateMock).toHaveBeenCalledWith({
      to: '/profile',
      upIsBack: true,
      backLabel: 'More',
    });
  });

  it('no longer carries an Appearance row (it lives on the profile now)', () => {
    render(<MoreTab />);

    expect(screen.queryByRole('button', { name: 'Appearance' })).not.toBeInTheDocument();
  });

  it('keeps the App group while the app can still be installed', () => {
    render(<MoreTab />);

    expect(screen.getByText('App')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Install app' })).toBeInTheDocument();
  });

  it('drops the whole App group once installed — no labelled empty box', () => {
    standalone = true;
    canPrompt = false;
    render(<MoreTab />);

    expect(screen.queryByRole('button', { name: 'Install app' })).not.toBeInTheDocument();
    // The label is the tell: leaving it behind renders a bordered blank.
    expect(screen.queryByText('App')).not.toBeInTheDocument();
    // The rest of the screen is unaffected.
    expect(screen.getByText('Organizations')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
  });

  it('also drops it in a browser with no install path at all', () => {
    canPrompt = false;
    iosTarget = false;
    render(<MoreTab />);

    expect(screen.queryByText('App')).not.toBeInTheDocument();
  });

  it('keeps Home and the org switcher reachable', () => {
    render(<MoreTab />);

    fireEvent.click(screen.getByRole('button', { name: 'Home' }));
    expect(navigateMock).toHaveBeenCalledWith({
      to: '/app',
      replace: true,
      orgId: null,
    });

    fireEvent.click(screen.getByRole('button', { name: 'All organizations' }));
    expect(openOrgSheet).toHaveBeenCalled();
  });
});
