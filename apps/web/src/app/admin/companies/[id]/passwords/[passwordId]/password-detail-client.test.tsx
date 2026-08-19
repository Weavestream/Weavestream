/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { PasswordGeneratorDefaults } from '@weavestream/shared';
import type { PasswordDetail } from '../../../../../../lib/server-api';
import {
  PasswordDetailClient,
  PasswordHeaderActions,
} from './password-detail-client';

const apiFetch = jest.fn();
const toast = { push: jest.fn() };
const copyToClipboard = jest.fn().mockResolvedValue(true);
const push = jest.fn();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh: jest.fn(), replace: jest.fn() }),
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
jest.mock('../../../../../../lib/api', () => ({
  apiFetch: (...a: unknown[]) => apiFetch(...a),
}));
// Only the browser entry is mocked — the root `@weavestream/shared` stays
// real so the actual safeExternalHref decides safe vs rejected below.
jest.mock('@weavestream/shared/browser', () => ({
  copyToClipboard: (...a: unknown[]) => copyToClipboard(...a),
}));

const IconStub = (_props: Record<string, unknown>) => <span />;
const toggleStar = jest.fn();
// The overflow menu and its rows come through real — the header's whole
// shape is which rows exist under which permission, so stubbing them
// would test nothing. Everything else stays a stub.
jest.mock('../../../../../../components/ui', () => {
  const actual = jest.requireActual<typeof import('../../../../../../components/ui')>(
    '../../../../../../components/ui',
  );
  return {
    OverflowMenu: actual.OverflowMenu,
    MenuItem: actual.MenuItem,
    MenuDivider: actual.MenuDivider,
    StarGlyph: actual.StarGlyph,
    useStarToggle: () => ({
      starred: false,
      pending: false,
      toggle: toggleStar,
      entityLabel: 'password',
    }),
    Btn: ({
      children,
      loading: _loading,
      icon: _icon,
      kind: _kind,
      size: _size,
      ...props
    }: React.ButtonHTMLAttributes<HTMLButtonElement> & Record<string, unknown>) => (
      <button {...props}>{children}</button>
    ),
    Dialog: ({
      open = true,
      title,
      footer,
      children,
    }: {
      open?: boolean;
      title?: React.ReactNode;
      footer?: React.ReactNode;
      children?: React.ReactNode;
    }) =>
      open ? (
        <div role="dialog" aria-label={typeof title === 'string' ? title : undefined}>
          {children}
          {footer}
        </div>
      ) : null,
    Field: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
    Icon: new Proxy({}, { get: () => IconStub }),
    Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => (
      <input {...props} />
    ),
    Panel: ({
      title,
      actions,
      children,
    }: {
      title?: React.ReactNode;
      actions?: React.ReactNode;
      children?: React.ReactNode;
    }) => (
      <section>
        <h3>{title}</h3>
        {actions}
        {children}
      </section>
    ),
    Select: (props: React.SelectHTMLAttributes<HTMLSelectElement>) => (
      <select {...props} />
    ),
    Tag: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
    Textarea: (props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => (
      <textarea {...props} />
    ),
    useToast: () => toast,
  };
});
jest.mock('../../../../../../lib/timezone-context', () => {
  const Stamp = ({ value }: { value: unknown }) => <span>{String(value)}</span>;
  return {
    FormattedCalendarDate: Stamp,
    FormattedDate: Stamp,
    FormattedDateTime: Stamp,
    FormattedShortDateTime: Stamp,
  };
});
jest.mock('../../../../../../components/passwords/password-reveal-field', () => ({
  PasswordRevealField: () => null,
}));
jest.mock('../../../../../../components/passwords/totp-code', () => ({
  TotpCode: () => null,
}));
jest.mock('../../../../../../components/passwords/password-strength-meter', () => ({
  PasswordStrengthMeter: () => null,
}));
jest.mock('../../../../../../components/passwords/secret-input', () => ({
  SecretInput: () => null,
}));
jest.mock('../../../../../../components/passwords/password-form-layout', () => ({
  PasswordAdvancedDisclosure: () => null,
  PasswordFieldGrid: () => null,
  PasswordFormSection: () => null,
  PasswordGhostAction: () => null,
  PasswordSettingChoice: () => null,
  PasswordTotpCard: () => null,
}));
jest.mock('../../../../../../components/tags/tags-input', () => ({
  TagsInput: () => null,
  toPlainNameList: () => [],
}));
jest.mock('../../../../../../components/relations', () => ({
  LinkedItemsPanel: () => null,
}));
jest.mock('../../../../../../components/upload/attachments-panel', () => ({
  AttachmentsPanel: () => null,
}));
jest.mock('../../../../../../lib/password-folder-tree', () => ({
  buildPasswordFolderOptions: () => [],
  formatFolderOptionLabel: () => '',
}));

const basePassword: PasswordDetail = {
  id: 'pw-1',
  companyId: 'co-1',
  folderId: null,
  assetId: null,
  name: 'Core router',
  username: 'admin',
  url: null,
  color: null,
  tags: [],
  hasTotp: false,
  passwordStrength: 3,
  pwnedCount: null,
  lastRotatedAt: null,
  rotationReminderDays: null,
  expiresAt: null,
  visibleToClients: false,
  requireReasonToView: false,
  restrictedToUserIds: [],
  archivedAt: null,
  createdBy: 'u-1',
  updatedBy: 'u-1',
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-02T00:00:00.000Z',
  notes: null,
  totpAlgorithm: 'SHA1',
  totpDigits: 6,
  totpPeriod: 30,
  isStarred: false,
};

function renderDetail(url: string | null) {
  return render(
    <PasswordDetailClient
      companyId="co-1"
      password={{ ...basePassword, url }}
      versions={[]}
      canManage={false}
      canManageInternalAccess={false}
      folderName={null}
      assetName={null}
      me={{ id: 'u-1', role: 'OPERATOR' }}
    />,
  );
}

afterEach(() => {
  jest.clearAllMocks();
});

describe('PasswordDetailClient URL row', () => {
  it('normalizes a scheme-less host:port to an https link with hardened attrs', () => {
    renderDetail('router.local:8443/admin');
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', 'https://router.local:8443/admin');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');
  });

  it('renders a data: value as plain text and still copies the raw value', async () => {
    renderDetail('data:text/html,hi');
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText('data:text/html,hi')).toBeInTheDocument();

    fireEvent.click(screen.getByTitle('Copy URL'));
    await waitFor(() =>
      expect(copyToClipboard).toHaveBeenCalledWith('data:text/html,hi'),
    );
  });

  it('shows — with no link and no copy button when the URL is null', () => {
    renderDetail(null);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.queryByTitle('Copy URL')).not.toBeInTheDocument();
  });

  it('treats a whitespace-only URL as absent', () => {
    renderDetail('   ');
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.queryByTitle('Copy URL')).not.toBeInTheDocument();
  });
});

function renderHeader(archivedAt: string | null = null, canManage = true) {
  return render(
    <PasswordHeaderActions
      companyId="co-1"
      password={{ ...basePassword, archivedAt }}
      folders={[]}
      canManage={canManage}
      generatorDefaults={{} as PasswordGeneratorDefaults}
    />,
  );
}

function openMenu() {
  fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
}

describe('PasswordHeaderActions archive confirmation (Phase 4)', () => {
  it('archive opens the confirm dialog; nothing fires until confirmed', async () => {
    apiFetch.mockResolvedValue({ ok: true });
    renderHeader();

    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Archive' }));
    expect(apiFetch).not.toHaveBeenCalled();
    // The row that opened a confirm closed the menu behind it.
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    const dialog = screen.getByRole('dialog', { name: 'Archive password?' });
    expect(dialog).toHaveTextContent('Core router will be hidden');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Archive' }));
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        '/companies/co-1/passwords/pw-1',
        expect.objectContaining({ method: 'DELETE' }),
      ),
    );
    expect(toast.push).toHaveBeenCalledWith('Password archived', 'ok');
    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', { name: 'Archive password?' }),
      ).not.toBeInTheDocument(),
    );
  });

  it('cancel archives nothing', () => {
    renderHeader();
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Archive' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(apiFetch).not.toHaveBeenCalled();
    expect(
      screen.queryByRole('dialog', { name: 'Archive password?' }),
    ).not.toBeInTheDocument();
  });

  it('restore stays one-click — it is the undo', async () => {
    apiFetch.mockResolvedValue({ ok: true });
    renderHeader('2026-07-01T00:00:00.000Z');

    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    expect(
      screen.queryByRole('dialog'),
    ).not.toBeInTheDocument();
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        '/companies/co-1/passwords/pw-1/restore',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
  });
});

describe('PasswordHeaderActions header shape', () => {
  it('leaves Edit in the row and folds the rest into the menu', () => {
    renderHeader();

    // The Star · Edit · Archive shelf is gone: Edit plus the trigger.
    expect(screen.getAllByRole('button')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    // No second star in a header whose global cluster already has one.
    expect(screen.queryByText('Star')).not.toBeInTheDocument();

    openMenu();
    expect(screen.getByRole('menuitem', { name: 'Star' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Archive' })).toBeInTheDocument();
  });

  it('gives the primary slot to Restore once archived, and offers no purge', () => {
    renderHeader('2026-07-01T00:00:00.000Z');

    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restore' })).toBeInTheDocument();

    openMenu();
    // No purge endpoint exists for a credential, so the archived menu
    // is the star alone — nothing to separate, hence no divider.
    expect(screen.getByRole('menuitem', { name: 'Star' })).toBeInTheDocument();
    expect(screen.getAllByRole('menuitem')).toHaveLength(1);
    expect(screen.queryByRole('menuitem', { name: 'Delete forever' })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Archive' })).not.toBeInTheDocument();
  });

  it('withholds every write action from a reader', () => {
    renderHeader(null, false);

    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restore' })).not.toBeInTheDocument();

    openMenu();
    expect(screen.getByRole('menuitem', { name: 'Star' })).toBeInTheDocument();
    expect(screen.getAllByRole('menuitem')).toHaveLength(1);
    expect(screen.queryByRole('menuitem', { name: 'Archive' })).not.toBeInTheDocument();
  });

  it('withholds Restore from a reader looking at an archived credential', () => {
    renderHeader('2026-07-01T00:00:00.000Z', false);

    expect(screen.queryByRole('button', { name: 'Restore' })).not.toBeInTheDocument();
    openMenu();
    expect(screen.getAllByRole('menuitem')).toHaveLength(1);
  });

  it('starring from the menu does not re-issue a /me/stars read', () => {
    renderHeader();
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Star' }));
    expect(toggleStar).toHaveBeenCalledTimes(1);
    expect(apiFetch).not.toHaveBeenCalled();
  });
});
