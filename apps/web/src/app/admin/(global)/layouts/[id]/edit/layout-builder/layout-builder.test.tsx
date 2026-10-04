/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { LayoutSummary } from '@weavestream/shared';
import { apiFetch } from '../../../../../../../lib/api';
import { LayoutBuilder } from './layout-builder';

const push = jest.fn();
const toast = { push: jest.fn() };

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh: jest.fn(), replace: jest.fn() }),
  usePathname: () => '/admin/layouts/layout-1/edit',
  useSearchParams: () => new URLSearchParams(),
}));
// Mocked for the same reason as `article-form.test.tsx`: the real
// TopBar pulls the global action cluster and, through it, the chat
// panel's ESM markdown cone, which ts-jest cannot load. Renders both
// slots so the stub stays honest if either is used again. This also
// intercepts `page-header`'s own import of TopBar, which is the chain
// the mobile branch would otherwise drag in.
jest.mock('../../../../../../../components/shell/top-bar', () => ({
  TopBar: ({ right, sub }: { right: React.ReactNode; sub: React.ReactNode }) => (
    <header>
      {right}
      {sub}
    </header>
  ),
}));
jest.mock('../../../../../../../lib/api', () => ({
  apiFetch: jest.fn().mockResolvedValue({ ok: true, data: null }),
}));
// `useSyncExternalStore` over `matchMedia`, which jsdom does not
// implement. Desktop is the branch under test — the mobile branch is a
// separate read-only notice with no action buttons.
jest.mock('../../../../../../../lib/hooks/use-is-mobile', () => ({
  useIsMobile: () => false,
}));
jest.mock('../../../layout-settings-dialog', () => ({
  LayoutSettingsDialog: ({ open }: { open: boolean }) =>
    open ? <div>settings dialog</div> : null,
}));
jest.mock('../../../layout-archive-dialog', () => ({
  LayoutArchiveDialog: ({ open }: { open: boolean }) =>
    open ? <div>archive dialog</div> : null,
}));
jest.mock('../../../../../../../components/ui', () => {
  const actual = jest.requireActual<
    typeof import('../../../../../../../components/ui')
  >('../../../../../../../components/ui');
  return { ...actual, useToast: () => toast };
});

const layout = {
  id: 'layout-1',
  name: 'Server / Network Device',
  slug: 'server-network-device',
  icon: 'server',
  color: 'var(--accent)',
  version: 3,
  archivedAt: null,
  fields: [],
} as unknown as LayoutSummary;

function renderBuilder(
  opts: { canEdit?: boolean; archivedAt?: string | null } = {},
) {
  const { canEdit = true, archivedAt = null } = opts;
  return render(
    <LayoutBuilder
      layout={{ ...layout, archivedAt }}
      stats={null}
      canEdit={canEdit}
      allLayouts={[]}
    />,
  );
}

/**
 * Header-scoped queries. The archived state also renders a Restore in
 * the banner below the header ("restore it to resume editing fields"),
 * which predates this header and stays — so an unscoped Restore query
 * matches two buttons.
 */
function header() {
  return within(screen.getByRole('banner'));
}

function openMenu() {
  fireEvent.click(header().getByRole('button', { name: 'More actions' }));
}

beforeEach(() => jest.clearAllMocks());

describe('LayoutBuilder header actions', () => {
  it('keeps Cancel and the primary in the row, folding the rest into the menu', () => {
    renderBuilder();

    // Cancel is the escape hatch and never hides in a menu.
    expect(header().getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(
      header().getByRole('button', { name: 'Save layout' }),
    ).toBeInTheDocument();
    // The four-button shelf is gone — Settings and Archive moved.
    expect(
      header().queryByRole('button', { name: 'Settings' }),
    ).not.toBeInTheDocument();
    expect(
      header().queryByRole('button', { name: 'Archive' }),
    ).not.toBeInTheDocument();

    openMenu();
    expect(
      header().getByRole('menuitem', { name: 'Settings' }),
    ).toBeInTheDocument();
    expect(
      header().getByRole('menuitem', { name: 'Archive' }),
    ).toBeInTheDocument();
  });

  it('closes the menu when a row opens a dialog over it', () => {
    renderBuilder();
    openMenu();
    fireEvent.click(header().getByRole('menuitem', { name: 'Settings' }));

    expect(screen.getByText('settings dialog')).toBeInTheDocument();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('gives the primary slot to Restore once archived, and drops Archive', () => {
    renderBuilder({ archivedAt: '2026-08-01T00:00:00.000Z' });

    expect(
      header().queryByRole('button', { name: 'Save layout' }),
    ).not.toBeInTheDocument();
    expect(header().getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    fireEvent.click(header().getByRole('button', { name: 'Restore' }));
    expect(screen.getByText('archive dialog')).toBeInTheDocument();

    openMenu();
    expect(
      header().getByRole('menuitem', { name: 'Settings' }),
    ).toBeInTheDocument();
    expect(
      header().queryByRole('menuitem', { name: 'Archive' }),
    ).not.toBeInTheDocument();
  });

  it('withholds every mutation from a reader without LAYOUT_MANAGE', () => {
    renderBuilder({ canEdit: false });

    expect(header().getByText('read only')).toBeInTheDocument();
    expect(
      header().queryByRole('button', { name: 'Cancel' }),
    ).not.toBeInTheDocument();
    expect(
      header().queryByRole('button', { name: 'Save layout' }),
    ).not.toBeInTheDocument();
    // No overflow trigger at all: every row it could hold is a
    // mutation, and an empty menu is worse than no menu.
    expect(
      header().queryByRole('button', { name: 'More actions' }),
    ).not.toBeInTheDocument();
  });

  it('withholds Restore from a reader looking at an archived layout', () => {
    renderBuilder({ canEdit: false, archivedAt: '2026-08-01T00:00:00.000Z' });

    // Unscoped on purpose: a reader must not reach Restore anywhere,
    // the archived banner's own copy of it included.
    expect(
      screen.queryByRole('button', { name: 'Restore' }),
    ).not.toBeInTheDocument();
    expect(
      header().queryByRole('button', { name: 'More actions' }),
    ).not.toBeInTheDocument();
  });
});

describe('LayoutBuilder field state wiring', () => {
  const nameField = {
    id: '00000000-0000-4000-8000-000000000001',
    name: 'Hostname',
    slug: 'hostname',
    fieldType: 'TEXT',
    position: 0,
    isRequired: false,
    isUniquePerCompany: false,
    visibleToClients: true,
    isPrimary: true,
    showInTable: false,
    options: {},
    archivedAt: null,
  };
  const serialField = {
    ...nameField,
    id: '00000000-0000-4000-8000-000000000002',
    name: 'Serial',
    slug: 'serial',
    position: 1,
    isPrimary: false,
  };

  function renderWithFields() {
    return render(
      <LayoutBuilder
        layout={{ ...layout, fields: [serialField, nameField] } as unknown as LayoutSummary}
        stats={null}
        canEdit
        allLayouts={[]}
      />,
    );
  }

  it('marks the layout unsaved after an edit and clean again after a save', async () => {
    const saved = { ...layout, fields: [nameField] };
    jest.mocked(apiFetch).mockResolvedValueOnce({ ok: true, data: saved } as never);
    renderWithFields();

    const save = header().getByRole('button', { name: 'Save layout' });
    expect(save).toBeDisabled();
    expect(header().queryByText('unsaved')).not.toBeInTheDocument();

    const removeButtons = screen.getAllByTitle('Remove field');
    // Rows render in position order: Hostname, then Serial.
    fireEvent.click(removeButtons[1]!);
    expect(header().getByText('unsaved')).toBeInTheDocument();
    expect(save).toBeEnabled();

    fireEvent.click(save);
    await waitFor(() => expect(toast.push).toHaveBeenCalledWith('Layout saved', 'ok'));
    expect(apiFetch).toHaveBeenCalledWith(
      '/layouts/layout-1/fields',
      expect.objectContaining({ method: 'PUT' }),
    );
    expect(header().queryByText('unsaved')).not.toBeInTheDocument();
  });

  it('opens the selected field in the inspector', () => {
    renderWithFields();

    // The first field is selected on load.
    expect(screen.getByDisplayValue('Hostname')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Serial'));
    expect(screen.getByDisplayValue('Serial')).toBeInTheDocument();
  });
});
