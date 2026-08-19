/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import { ArticleHeaderActions } from './article-header-actions';

jest.mock('./history-panel', () => ({
  HistoryPanel: ({ open }: { open: boolean }) =>
    open ? <div>history panel</div> : null,
}));

const requestArchiveToggle = jest.fn();
const requestPurge = jest.fn();
let archived = false;

jest.mock('../article-actions', () => ({
  useArticleArchive: () => ({
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
      entityLabel: 'article',
    }),
  };
});

const article = {
  id: 'article-1',
  title: 'Administering PostgreSQL',
  archivedAt: null as string | null,
  folderId: 'folder-1',
  isStarred: false,
  hasDraft: false,
};

function open() {
  fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
}

beforeEach(() => {
  archived = false;
  jest.clearAllMocks();
});

describe('ArticleHeaderActions', () => {
  it('leaves one primary action in the row and folds the rest into the menu', () => {
    render(
      <ArticleHeaderActions companyId="c1" article={article} manage />,
    );

    // The five-button shelf is gone: Edit plus the overflow trigger.
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.getByRole('link', { name: /Edit/ })).toHaveAttribute(
      'href',
      '/admin/companies/c1/articles/article-1/edit',
    );
    expect(screen.queryByText('Star')).not.toBeInTheDocument();

    open();
    expect(screen.getByRole('menuitem', { name: 'Star' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'History' })).toBeInTheDocument();
    expect(
      screen.getByRole('menuitem', { name: 'New article' }),
    ).toHaveAttribute(
      'href',
      '/admin/companies/c1/articles/new?folderId=folder-1',
    );
    expect(screen.getByRole('menuitem', { name: 'Archive' })).toBeInTheDocument();
  });

  it('gives the primary slot to Restore once archived, with purge behind the menu', () => {
    archived = true;
    render(
      <ArticleHeaderActions
        companyId="c1"
        article={{ ...article, archivedAt: '2026-08-01T00:00:00.000Z' }}
        manage
      />,
    );

    expect(screen.queryByRole('link', { name: /Edit/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    expect(requestArchiveToggle).toHaveBeenCalledTimes(1);

    open();
    expect(screen.queryByRole('menuitem', { name: 'Archive' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete forever' }));
    expect(requestPurge).toHaveBeenCalledTimes(1);
  });

  it('withholds every write action from a reader', () => {
    render(
      <ArticleHeaderActions companyId="c1" article={article} manage={false} />,
    );

    expect(screen.queryByRole('link', { name: /Edit/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restore' })).not.toBeInTheDocument();

    open();
    expect(screen.getByRole('menuitem', { name: 'Star' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'History' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'New article' })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Archive' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('menuitem', { name: 'Delete forever' }),
    ).not.toBeInTheDocument();
  });

  it('marks the collapsed menu when it hides a draft in progress', () => {
    const { rerender } = render(
      <ArticleHeaderActions companyId="c1" article={article} manage />,
    );
    expect(
      screen.queryByRole('img', { name: 'needs attention' }),
    ).not.toBeInTheDocument();

    rerender(
      <ArticleHeaderActions
        companyId="c1"
        article={{ ...article, hasDraft: true }}
        manage
      />,
    );
    expect(screen.getByRole('img', { name: 'needs attention' })).toBeInTheDocument();

    open();
    expect(screen.getByRole('menuitem', { name: /History/ })).toHaveTextContent(
      'draft',
    );
  });

  it('closes the menu when a row opens a panel over it', () => {
    render(
      <ArticleHeaderActions companyId="c1" article={article} manage />,
    );
    open();
    fireEvent.click(screen.getByRole('menuitem', { name: 'History' }));

    expect(screen.getByText('history panel')).toBeInTheDocument();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});
