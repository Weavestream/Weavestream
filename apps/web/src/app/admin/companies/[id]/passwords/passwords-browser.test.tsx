/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import type { PasswordGeneratorDefaults } from '@weavestream/shared';
import type { PasswordFolderRow, PasswordSummary } from '../../../../../lib/server-api';
import { PasswordsBrowser } from './passwords-browser';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), refresh: jest.fn(), replace: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
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
jest.mock('../../../../../lib/api', () => ({ apiFetch: jest.fn() }));
jest.mock('../../../../../lib/hooks/use-is-mobile', () => ({
  // Desktop for both call sites: the phone breakpoint and the narrower
  // one the rail collapses at. The rail is a column here, not a tab.
  useIsMobile: () => false,
}));
jest.mock('../../../../../components/passwords/password-strength-meter', () => ({
  PasswordStrengthMeter: () => <span />,
}));
jest.mock('../../../../../components/passwords/create-password-dialog', () => ({
  CreatePasswordDialog: () => null,
}));
jest.mock('../../../../../components/passwords/password-row-actions', () => ({
  PasswordRowActions: () => <span />,
}));
jest.mock('../../../../../components/passwords/totp-code', () => ({
  TotpCode: () => <span />,
}));
jest.mock('./password-folder-settings-dialog', () => ({
  PasswordFolderSettingsDialog: ({
    open,
    folder,
  }: {
    open: boolean;
    folder: { name: string };
  }) => (open ? <div data-testid="folder-settings">{folder.name}</div> : null),
}));

const folder = (
  id: string,
  name: string,
  parentId: string | null = null,
): PasswordFolderRow => ({
  id,
  companyId: 'c1',
  parentId,
  name,
  icon: null,
  color: null,
  position: 0,
  archivedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

const row = (id: string, name: string, folderId: string | null): PasswordSummary => ({
  id,
  companyId: 'c1',
  folderId,
  assetId: null,
  name,
  username: 'u',
  url: null,
  color: null,
  tags: [],
  hasTotp: false,
  passwordStrength: 0,
  pwnedCount: null,
  lastRotatedAt: null,
  rotationReminderDays: null,
  expiresAt: null,
  visibleToClients: false,
  requireReasonToView: false,
  restrictedToUserIds: [],
  archivedAt: null,
  createdBy: 'u1',
  updatedBy: 'u1',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

function renderBrowser() {
  return render(
    <PasswordsBrowser
      companyId="c1"
      rows={[row('p1', 'One', 'f1'), row('p2', 'Two', 'f3')]}
      folders={[
        folder('f1', 'Common'),
        folder('f2', 'Microsoft 365', 'f1'),
        folder('f3', 'Client sites'),
      ]}
      canManage
      generatorDefaults={{} as PasswordGeneratorDefaults}
      showCounts={false}
    />,
  );
}

/**
 * The folder rail used to be a `role="button"` row with the disclosure and
 * edit controls nested inside it. Clicks were guarded with
 * `stopPropagation`, but key events were not — so Enter or Space on a
 * nested control bubbled to the row's `onKeyDown`, which called
 * `preventDefault()` (cancelling the native activation) and selected the
 * folder instead. These tests pin the shape that fixed it: the controls
 * are siblings, and no ancestor is pretending to be a button.
 */
describe('passwords folder rail — nested control activation', () => {
  it('does not steal the selection when a key event reaches a folder control', () => {
    renderBrowser();

    fireEvent.click(screen.getByRole('button', { name: 'Client sites' }));
    expect(screen.getByRole('button', { name: 'Client sites' })).toHaveAttribute(
      'aria-current',
      'true',
    );

    // Enter on another folder's chevron must not select that folder.
    fireEvent.keyDown(screen.getByLabelText('Collapse Common'), { key: 'Enter' });
    fireEvent.keyDown(screen.getByLabelText('Collapse Common'), { key: ' ' });

    expect(screen.getByRole('button', { name: 'Client sites' })).toHaveAttribute(
      'aria-current',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Common' })).not.toHaveAttribute(
      'aria-current',
    );
  });

  it('keeps the rail controls as siblings, never nested in a button', () => {
    const { container } = renderBrowser();

    // Nothing in the rail may pose as a button: an element with that role
    // must not contain focusable descendants, and it is the parent key
    // handler such a wrapper carries that broke activation before.
    expect(container.querySelectorAll('[role="button"]')).toHaveLength(0);

    const chevron = screen.getByLabelText('Collapse Common');
    expect(chevron.closest('button')).toBe(chevron);

    fireEvent.click(screen.getByRole('button', { name: 'Common' }));
    const edit = screen.getByLabelText('Edit folder Common');
    expect(edit.closest('button')).toBe(edit);
  });

  it('activates the disclosure and the edit control on their own', () => {
    renderBrowser();

    fireEvent.click(screen.getByRole('button', { name: 'Common' }));
    expect(screen.getByRole('button', { name: 'Microsoft 365' })).toBeInTheDocument();

    // Collapsing hides the child without disturbing the selection.
    fireEvent.click(screen.getByLabelText('Collapse Common'));
    expect(screen.queryByRole('button', { name: 'Microsoft 365' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Common' })).toHaveAttribute(
      'aria-current',
      'true',
    );

    fireEvent.click(screen.getByLabelText('Edit folder Common'));
    expect(screen.getByTestId('folder-settings')).toHaveTextContent('Common');
  });
});
