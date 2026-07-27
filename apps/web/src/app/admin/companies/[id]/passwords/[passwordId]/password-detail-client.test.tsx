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
jest.mock('../../../../../../components/ui', () => ({
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
  StarButton: () => null,
  Tag: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  Textarea: (props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => (
    <textarea {...props} />
  ),
  useToast: () => toast,
}));
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

describe('PasswordHeaderActions archive confirmation (Phase 4)', () => {
  function renderHeader(archivedAt: string | null = null) {
    return render(
      <PasswordHeaderActions
        companyId="co-1"
        password={{ ...basePassword, archivedAt }}
        folders={[]}
        canManage
        generatorDefaults={{} as PasswordGeneratorDefaults}
      />,
    );
  }

  it('archive opens the confirm dialog; nothing fires until confirmed', async () => {
    apiFetch.mockResolvedValue({ ok: true });
    renderHeader();

    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    expect(apiFetch).not.toHaveBeenCalled();
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
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
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
