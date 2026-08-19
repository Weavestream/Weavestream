/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ArticleDetail, FolderNode } from '../../../../../lib/server-api';
import { ArticleForm } from './article-form';

jest.mock('next/navigation', () => ({
  useRouter: () => ({
    push: jest.fn(),
    refresh: jest.fn(),
  }),
}));

jest.mock('../../../../../components/shell/top-bar', () => ({
  // The editor's controls moved from the `sub` row into the breadcrumb
  // row's `right` slot; render both so the stub stays honest if either
  // is used again.
  TopBar: ({ right, sub }: { right: React.ReactNode; sub: React.ReactNode }) => (
    <header>
      {right}
      {sub}
    </header>
  ),
}));

jest.mock('../../../../../components/editor/rich-text-editor', () => ({
  RichTextEditor: ({ toolbarEnd }: { toolbarEnd?: React.ReactNode }) => (
    <div data-testid="rich-text-editor">{toolbarEnd}</div>
  ),
}));

jest.mock('../../../../../components/editor/markdown-editor', () => ({
  MarkdownEditor: ({
    toolbarEnd,
    view,
    onViewChange,
  }: {
    toolbarEnd?: React.ReactNode;
    view: string;
    onViewChange: (next: 'edit' | 'split' | 'preview') => void;
  }) => (
    <div data-testid="markdown-editor" data-view={view}>
      {toolbarEnd}
      <button type="button" onClick={() => onViewChange('split')}>
        Use split view
      </button>
    </div>
  ),
}));

const mockLinkedItemsPanel = jest.fn((_props: unknown) => <div>Functional linked items</div>);
jest.mock('../../../../../components/relations', () => ({
  LinkedItemsPanel: (props: unknown) => mockLinkedItemsPanel(props),
}));

const mockAttachmentsPanel = jest.fn((_props: unknown) => <div>Functional attachments</div>);
jest.mock('../../../../../components/upload/attachments-panel', () => ({
  AttachmentsPanel: (props: unknown) => mockAttachmentsPanel(props),
}));

jest.mock('../../../../../components/chat-panel/use-chat-page-context', () => ({
  useChatPageContext: jest.fn(),
}));

jest.mock('../../../../../lib/article-format', () => ({
  tiptapDocToMarkdown: () => '# Converted',
  markdownToTiptapDoc: () => ({
    type: 'doc',
    content: [{ type: 'paragraph' }],
  }),
}));

// The header's archive controls talk to the API, the router and the
// toast provider. The form only needs the hook's shape: the overflow
// menu reads `archived` to choose between Archive and Delete forever.
jest.mock('./article-actions', () => ({
  useArticleArchive: () => ({
    archived: false,
    requestArchiveToggle: jest.fn(),
    requestPurge: jest.fn(),
    dialogs: null,
  }),
}));

// `useIsMobile(768)` and `useIsMobile(1240)` are two different
// questions; the form branches on both. `narrowOnly` is a 768–1239px
// laptop: rails collapsed, phone affordances absent.
let viewport: 'desktop' | 'narrowOnly' | 'phone' = 'desktop';
jest.mock('../../../../../lib/hooks/use-is-mobile', () => ({
  useIsMobile: (breakpoint = 768) => {
    if (viewport === 'phone') return true;
    if (viewport === 'narrowOnly') return breakpoint > 768;
    return false;
  },
}));

jest.mock('../../../../../components/ui', () => {
  const actual = jest.requireActual('../../../../../components/ui');
  return {
    ...actual,
    useToast: () => ({ push: jest.fn() }),
  };
});

const folders = [
  {
    id: 'folder-1',
    name: 'Runbooks',
    slug: 'runbooks',
    icon: null,
    position: 0,
    parentId: null,
    archivedAt: null,
    articleCount: 0,
    children: [],
  },
] satisfies FolderNode[];

const article = {
  id: 'article-1',
  title: 'Existing article',
  folderId: 'folder-1',
  visibleToClients: true,
  editorMode: 'tiptap',
  content: { type: 'doc', content: [{ type: 'paragraph' }] },
  markdownSource: null,
  updatedAt: '2026-07-30T12:00:00.000Z',
  hasDraft: false,
  revision: 3,
  archivedAt: null,
} as ArticleDetail;

beforeEach(() => {
  jest.clearAllMocks();
  viewport = 'desktop';
});

describe('ArticleForm editor layout', () => {
  it('uses toolbar format switching, aligned canvas widths, and safe create placeholders', () => {
    const { container } = render(
      <ArticleForm
        companyId="company-1"
        companyLabel="Acme"
        mode="create"
        folders={folders}
        autosaveEnabled={false}
        defaultEditorMode="tiptap"
      />,
    );

    const title = screen.getByPlaceholderText('Article title…');
    expect(title.parentElement).toHaveStyle({ maxWidth: '920px' });
    expect(screen.getByLabelText('Folder')).toBeInTheDocument();
    expect(screen.getByLabelText('Visible to clients')).toBeChecked();
    expect(screen.getByText('Linked items')).toBeInTheDocument();
    expect(screen.getByText('Attachments')).toBeInTheDocument();
    expect(screen.getAllByText('Save the article first to add items here.')).toHaveLength(2);
    expect(mockLinkedItemsPanel).not.toHaveBeenCalled();
    expect(mockAttachmentsPanel).not.toHaveBeenCalled();

    const status = container.querySelector('.article-editor-save-status');
    const discard = screen.getByRole('button', { name: 'Discard' });
    expect(status?.compareDocumentPosition(discard)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    fireEvent.change(screen.getByLabelText('Editor format'), {
      target: { value: 'markdown' },
    });

    expect(screen.getByTestId('markdown-editor')).toBeInTheDocument();
    expect(title.parentElement).toHaveStyle({ maxWidth: '1200px' });

    fireEvent.click(screen.getByRole('button', { name: 'Use split view' }));
    expect(title.parentElement).toHaveStyle({ maxWidth: 'none' });
  });

  it('preserves edit-mode conversion confirmation and sidebar ordering', () => {
    render(
      <ArticleForm
        companyId="company-1"
        companyLabel="Acme"
        mode="edit"
        folders={folders}
        article={article}
        autosaveEnabled
        defaultEditorMode="markdown"
      />,
    );

    const folderLabel = screen.getByText('Folder');
    const visibilityLabel = screen.getByText('Visibility');
    const linked = screen.getByText('Functional linked items');
    const attachments = screen.getByText('Functional attachments');
    expect(folderLabel.compareDocumentPosition(visibilityLabel)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(visibilityLabel.compareDocumentPosition(linked)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(linked.compareDocumentPosition(attachments)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    fireEvent.change(screen.getByLabelText('Editor format'), {
      target: { value: 'markdown' },
    });

    expect(screen.getByRole('dialog', { name: 'Switch editor format?' })).toBeInTheDocument();
    expect(screen.getByTestId('rich-text-editor')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Switch' }));
    expect(screen.getByTestId('markdown-editor')).toBeInTheDocument();
  });

  it('keeps folder and visibility reachable while creating on a laptop', () => {
    // Regression: below 1240 the properties rail is gone and the phone's
    // floating trigger has not appeared yet, so the header menu is the
    // only route to it. Gating that menu on edit mode stranded every
    // new article between 768 and 1239px.
    viewport = 'narrowOnly';
    render(
      <ArticleForm
        companyId="company-1"
        companyLabel="Acme"
        mode="create"
        folders={folders}
        autosaveEnabled={false}
        defaultEditorMode="tiptap"
      />,
    );

    expect(screen.queryByLabelText('Folder')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));

    // Create mode has nothing to preview or archive yet, so Details is
    // the whole menu.
    fireEvent.click(screen.getByRole('menuitem', { name: 'Details' }));
    expect(screen.queryByRole('menuitem', { name: 'Preview' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Folder')).toBeInTheDocument();
    expect(screen.getByLabelText('Visible to clients')).toBeInTheDocument();
  });

  it('keeps the properties rail inline on a full-width desktop', () => {
    render(
      <ArticleForm
        companyId="company-1"
        companyLabel="Acme"
        mode="create"
        folders={folders}
        autosaveEnabled={false}
        defaultEditorMode="tiptap"
      />,
    );
    expect(screen.getByLabelText('Folder')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'More actions' }),
    ).not.toBeInTheDocument();
  });
});
