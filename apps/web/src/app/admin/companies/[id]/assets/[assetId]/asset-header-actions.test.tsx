/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import { AssetHeaderActions } from './asset-header-actions';

const requestArchiveToggle = jest.fn();
const requestPurge = jest.fn();
let archived = false;

jest.mock('./asset-actions', () => ({
  useAssetArchive: () => ({
    archived,
    requestArchiveToggle,
    requestPurge,
    dialogs: null,
  }),
}));

const toggleStar = jest.fn();
jest.mock('../../../../../../components/ui', () => {
  const actual = jest.requireActual('../../../../../../components/ui');
  return {
    ...actual,
    useStarToggle: () => ({
      starred: false,
      pending: false,
      toggle: toggleStar,
      entityLabel: 'asset',
    }),
  };
});

const asset = {
  id: 'asset-1',
  name: 'ACM-DB01',
  archivedAt: null as string | null,
  assetLayoutId: 'layout-1',
  externalSource: null as string | null,
  isStarred: false,
};

function open() {
  fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
}

beforeEach(() => {
  archived = false;
  jest.clearAllMocks();
});

describe('AssetHeaderActions', () => {
  it('leaves one primary action in the row and folds the rest into the menu', () => {
    render(<AssetHeaderActions companyId="c1" asset={asset} manage />);

    // The five-button shelf is gone: Edit plus the overflow trigger.
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.getByRole('link', { name: /Edit/ })).toHaveAttribute(
      'href',
      '/admin/companies/c1/assets/asset-1/edit',
    );
    expect(screen.queryByText('Star')).not.toBeInTheDocument();

    open();
    expect(screen.getByRole('menuitem', { name: 'Star' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'New asset' })).toHaveAttribute(
      'href',
      '/admin/companies/c1/assets/new?layout=layout-1',
    );
    expect(
      screen.getByRole('menuitem', { name: 'Archive' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('menuitem', { name: 'Delete forever' }),
    ).not.toBeInTheDocument();
  });

  it('gives the primary slot to Restore once archived, with purge behind the menu', () => {
    archived = true;
    render(
      <AssetHeaderActions
        companyId="c1"
        asset={{ ...asset, archivedAt: '2026-08-01T00:00:00.000Z' }}
        manage
      />,
    );

    expect(screen.queryByRole('link', { name: /Edit/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    expect(requestArchiveToggle).toHaveBeenCalledTimes(1);

    open();
    expect(
      screen.queryByRole('menuitem', { name: 'Archive' }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete forever' }));
    expect(requestPurge).toHaveBeenCalledTimes(1);
    // The row that opened a confirm closed the menu behind it.
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('withholds every write action from a reader', () => {
    render(<AssetHeaderActions companyId="c1" asset={asset} manage={false} />);

    expect(screen.queryByRole('link', { name: /Edit/ })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Restore' }),
    ).not.toBeInTheDocument();

    open();
    expect(screen.getByRole('menuitem', { name: 'Star' })).toBeInTheDocument();
    expect(
      screen.queryByRole('menuitem', { name: 'New asset' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('menuitem', { name: 'Archive' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('menuitem', { name: 'Delete forever' }),
    ).not.toBeInTheDocument();
  });

  it('withholds purge from a reader looking at an archived asset', () => {
    archived = true;
    render(
      <AssetHeaderActions
        companyId="c1"
        asset={{ ...asset, archivedAt: '2026-08-01T00:00:00.000Z' }}
        manage={false}
      />,
    );

    expect(
      screen.queryByRole('button', { name: 'Restore' }),
    ).not.toBeInTheDocument();
    open();
    expect(
      screen.queryByRole('menuitem', { name: 'Delete forever' }),
    ).not.toBeInTheDocument();
  });

  it('starring from the menu does not re-issue a /me/stars read', () => {
    render(<AssetHeaderActions companyId="c1" asset={asset} manage />);
    open();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Star' }));
    expect(toggleStar).toHaveBeenCalledTimes(1);
  });

  it('carries no attention dot — nothing it hides needs review', () => {
    render(<AssetHeaderActions companyId="c1" asset={asset} manage />);
    expect(
      screen.queryByRole('img', { name: 'needs attention' }),
    ).not.toBeInTheDocument();
  });
});
