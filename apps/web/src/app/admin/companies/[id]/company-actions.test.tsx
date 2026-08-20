/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import type { CompanyDetail } from '../../../../lib/server-api';
import { CompanyActions } from './company-actions';

const refresh = jest.fn();
const apiFetch = jest.fn();
const toastPush = jest.fn();
const toggleStar = jest.fn();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), refresh, replace: jest.fn() }),
}));
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({
    href,
    children,
    prefetch: _prefetch,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
    href: string;
    prefetch?: boolean;
    children: React.ReactNode;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));
jest.mock('../../../../lib/api', () => ({
  apiFetch: (...a: unknown[]) => apiFetch(...a),
}));
// The overflow menu, its rows, and the dialog come through real — the
// header's whole shape is which rows exist under which permission.
// Only the two context hooks are stubbed, since neither provider is
// mounted here.
jest.mock('../../../../components/ui', () => {
  const actual =
    jest.requireActual<typeof import('../../../../components/ui')>(
      '../../../../components/ui',
    );
  return {
    ...actual,
    useToast: () => ({ push: toastPush }),
    useStarToggle: () => ({
      starred: false,
      pending: false,
      toggle: toggleStar,
      entityLabel: 'company',
    }),
  };
});

const company = {
  id: 'co-1',
  name: 'Acme Corp',
  slug: 'acme-corp',
  archivedAt: null,
  isStarred: false,
} as unknown as CompanyDetail;

function open() {
  fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(window, 'open').mockReturnValue(null);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('CompanyActions', () => {
  it('leaves nothing in the row but the overflow trigger', () => {
    render(<CompanyActions company={company} manage />);

    // The four-button shelf is gone. None of Star, Preview portal,
    // Edit, or Archive was the action an operator came for, so the row
    // has no primary control at all — just the menu.
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'More actions' })).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('folds all four actions into the menu', () => {
    render(<CompanyActions company={company} manage />);
    open();

    expect(screen.getByRole('menuitem', { name: 'Star' })).toBeInTheDocument();
    expect(
      screen.getByRole('menuitem', { name: 'Preview portal' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Edit' })).toHaveAttribute(
      'href',
      '/admin/companies/co-1/settings',
    );
    expect(screen.getByRole('menuitem', { name: 'Archive' })).toBeInTheDocument();
  });

  it('opens the portal in its own tab and closes the menu behind it', () => {
    render(<CompanyActions company={company} manage />);
    open();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Preview portal' }));

    expect(window.open).toHaveBeenCalledWith(
      '/portal/acme-corp',
      '_blank',
      'noopener,noreferrer',
    );
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('confirms before archiving, with the menu closed behind the dialog', () => {
    render(<CompanyActions company={company} manage />);
    open();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Archive' }));

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(screen.getByText('Archive company?')).toBeInTheDocument();
    // Confirming is what calls the API — the menu row only opens the
    // dialog.
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('swaps Archive for Restore once archived, keeping Edit reachable', () => {
    render(
      <CompanyActions
        company={{ ...company, archivedAt: '2026-08-01T00:00:00.000Z' } as CompanyDetail}
        manage
      />,
    );
    // Edit still works on an archived company, so — unlike assets,
    // articles, and passwords — Restore is not promoted into the row.
    expect(screen.getAllByRole('button')).toHaveLength(1);

    open();
    expect(screen.getByRole('menuitem', { name: 'Restore' })).toBeInTheDocument();
    expect(
      screen.queryByRole('menuitem', { name: 'Archive' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Edit' })).toBeInTheDocument();
  });

  it('withholds every write action from a reader', () => {
    render(<CompanyActions company={company} manage={false} />);
    open();

    expect(screen.getByRole('menuitem', { name: 'Star' })).toBeInTheDocument();
    expect(
      screen.getByRole('menuitem', { name: 'Preview portal' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Edit' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('menuitem', { name: 'Archive' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('menuitem', { name: 'Restore' }),
    ).not.toBeInTheDocument();
  });

  it('withholds restore from a reader looking at an archived company', () => {
    render(
      <CompanyActions
        company={{ ...company, archivedAt: '2026-08-01T00:00:00.000Z' } as CompanyDetail}
        manage={false}
      />,
    );
    open();

    expect(
      screen.queryByRole('menuitem', { name: 'Restore' }),
    ).not.toBeInTheDocument();
  });

  it('starring from the menu does not re-issue a /me/stars read', () => {
    render(<CompanyActions company={company} manage />);
    open();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Star' }));

    expect(toggleStar).toHaveBeenCalledTimes(1);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('carries no attention dot — the archived state stays visible in the title', () => {
    render(
      <CompanyActions
        company={{ ...company, archivedAt: '2026-08-01T00:00:00.000Z' } as CompanyDetail}
        manage
      />,
    );

    expect(
      screen.queryByRole('img', { name: 'needs attention' }),
    ).not.toBeInTheDocument();
  });
});
