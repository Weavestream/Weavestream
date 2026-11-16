/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { FolderNode } from '@weavestream/shared';
import { apiFetch } from '../../../../../lib/api';
import type { ArticleDetail } from '../../../../../lib/server-api/articles';
import { ArticleForm } from './article-form';

const mockPush = jest.fn();
const mockToastPush = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
    refresh: jest.fn(),
  }),
}));

jest.mock('../../../../../lib/api', () => ({ apiFetch: jest.fn() }));
const mockApiFetch = apiFetch as jest.MockedFunction<typeof apiFetch>;

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
    useToast: () => ({ push: mockToastPush }),
  };
});

const folders = [
  {
    id: 'folder-1',
    companyId: 'company-1',
    name: 'Runbooks',
    slug: 'runbooks',
    icon: null,
    position: 0,
    parentId: null,
    archivedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
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

describe('ArticleForm Save draft (#117)', () => {
  function openSaveMenu() {
    fireEvent.click(screen.getByRole('button', { name: 'Draft options' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Save draft' }));
  }

  it('saves a draft of an existing article without leaving the editor', async () => {
    mockApiFetch.mockResolvedValue({
      ok: true,
      status: 200,
      data: { revision: 4, hasDraft: true },
    } as Awaited<ReturnType<typeof apiFetch>>);
    render(
      <ArticleForm
        companyId="company-1"
        companyLabel="Acme"
        mode="edit"
        folders={folders}
        article={article}
        autosaveEnabled={false}
        defaultEditorMode="tiptap"
      />,
    );

    // Only Publish publishes, so the primary is never labelled Save; the
    // draft is secondary.
    expect(screen.getByRole('button', { name: 'Publish' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save draft' })).not.toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('Article title…'), {
      target: { value: 'Existing article v2' },
    });
    openSaveMenu();

    await waitFor(() => expect(screen.getByText('draft')).toBeInTheDocument());
    expect(mockApiFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockApiFetch.mock.calls[0]!;
    expect(url).toBe('/companies/company-1/articles/article-1');
    expect(init?.method).toBe('PATCH');
    expect(JSON.parse(String(init?.body))).toMatchObject({
      title: 'Existing article v2',
      draft: true,
    });
    expect(mockPush).not.toHaveBeenCalled();
    expect(mockToastPush).toHaveBeenCalledWith('Draft saved', 'ok');
  });

  it('does not claim a draft save when nothing changed', async () => {
    render(
      <ArticleForm
        companyId="company-1"
        companyLabel="Acme"
        mode="edit"
        folders={folders}
        article={article}
        autosaveEnabled={false}
        defaultEditorMode="tiptap"
      />,
    );

    openSaveMenu();

    // The server would no-op (no draft row), so nothing is sent.
    await waitFor(() =>
      expect(mockToastPush).toHaveBeenCalledWith('No changes to save as a draft', 'ok'),
    );
    expect(mockApiFetch).not.toHaveBeenCalled();
  });

  it('publishes without the draft flag from the primary button', async () => {
    mockApiFetch.mockResolvedValue({
      ok: true,
      status: 200,
      data: { revision: 4, hasDraft: false },
    } as Awaited<ReturnType<typeof apiFetch>>);
    render(
      <ArticleForm
        companyId="company-1"
        companyLabel="Acme"
        mode="edit"
        folders={folders}
        article={article}
        autosaveEnabled={false}
        defaultEditorMode="tiptap"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));

    await waitFor(() =>
      expect(mockPush).toHaveBeenCalledWith('/admin/companies/company-1/articles/article-1'),
    );
    const body = JSON.parse(String(mockApiFetch.mock.calls[0]![1]?.body));
    expect(body).not.toHaveProperty('draft');
  });

  it('creates a new article and reopens it in the editor', async () => {
    mockApiFetch.mockResolvedValue({
      ok: true,
      status: 201,
      data: { id: 'article-9' },
    } as Awaited<ReturnType<typeof apiFetch>>);
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

    expect(screen.getByRole('button', { name: 'Publish' })).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('Article title…'), {
      target: { value: 'Work in progress' },
    });
    openSaveMenu();

    await waitFor(() =>
      expect(mockPush).toHaveBeenCalledWith('/admin/companies/company-1/articles/article-9/edit'),
    );
    const [url, init] = mockApiFetch.mock.calls[0]!;
    expect(url).toBe('/companies/company-1/articles');
    expect(init?.method).toBe('POST');
    // `draft: true` makes v1 a never-published draft.
    expect(JSON.parse(String(init?.body))).toMatchObject({
      title: 'Work in progress',
      draft: true,
    });
    expect(mockToastPush).toHaveBeenCalledWith('Draft saved — not published', 'ok');
  });

  it('publishes a new article without the draft flag', async () => {
    mockApiFetch.mockResolvedValue({
      ok: true,
      status: 201,
      data: { id: 'article-9' },
    } as Awaited<ReturnType<typeof apiFetch>>);
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
    fireEvent.change(screen.getByPlaceholderText('Article title…'), {
      target: { value: 'Live now' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));

    await waitFor(() =>
      expect(mockPush).toHaveBeenCalledWith('/admin/companies/company-1/articles/article-9'),
    );
    expect(JSON.parse(String(mockApiFetch.mock.calls[0]![1]?.body))).not.toHaveProperty('draft');
  });

  it('reports a missing body when saving a new Markdown draft', async () => {
    render(
      <ArticleForm
        companyId="company-1"
        companyLabel="Acme"
        mode="create"
        folders={folders}
        autosaveEnabled={false}
        defaultEditorMode="markdown"
      />,
    );

    fireEvent.change(screen.getByPlaceholderText('Article title…'), {
      target: { value: 'Work in progress' },
    });

    // No body yet: the user asked to save, so the validation error shows.
    openSaveMenu();
    expect(await screen.findByText('Add some Markdown content before saving.')).toBeInTheDocument();
    expect(mockApiFetch).not.toHaveBeenCalled();
  });
});

describe('ArticleForm draft labels and Cancel (#117)', () => {
  function renderEdit(overrides: Partial<ArticleDetail>) {
    render(
      <ArticleForm
        companyId="company-1"
        companyLabel="Acme"
        mode="edit"
        folders={folders}
        article={{ ...article, ...overrides } as ArticleDetail}
        autosaveEnabled={false}
        defaultEditorMode="tiptap"
      />,
    );
  }

  it('labels a never-published article and lets Cancel leave without touching the draft', async () => {
    renderEdit({ hasDraft: true, isPublished: false });

    expect(screen.getByText('not published')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Draft options' }));
    // Nothing published to revert to, so no Discard draft.
    expect(screen.queryByRole('menuitem', { name: 'Discard draft' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(mockPush).toHaveBeenCalledWith('/admin/companies/company-1/articles/article-1'),
    );
    expect(mockApiFetch).not.toHaveBeenCalled();
  });

  it('Cancel with unsaved edits keeps the saved draft', async () => {
    renderEdit({ hasDraft: true, isPublished: true });
    fireEvent.change(screen.getByPlaceholderText('Article title…'), {
      target: { value: 'Changed' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByRole('dialog', { name: 'Discard unsaved changes?' })).toBeInTheDocument();
    expect(screen.getByText(/The saved draft is kept\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));

    await waitFor(() => expect(mockPush).toHaveBeenCalled());
    expect(mockApiFetch).not.toHaveBeenCalled();
  });

  it('Discard draft deletes the draft of a published article', async () => {
    mockApiFetch.mockResolvedValue({ ok: true, status: 200, data: {} } as Awaited<
      ReturnType<typeof apiFetch>
    >);
    renderEdit({ hasDraft: true, isPublished: true });
    expect(screen.getByText('draft')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Draft options' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Discard draft' }));
    expect(screen.getByRole('dialog', { name: 'Discard draft?' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Discard draft' }));

    await waitFor(() => expect(mockPush).toHaveBeenCalled());
    const [url, init] = mockApiFetch.mock.calls[0]!;
    expect(url).toBe('/companies/company-1/articles/article-1/draft');
    expect(init?.method).toBe('DELETE');
  });
});

describe('ArticleForm save races (review findings)', () => {
  type FetchResult = Awaited<ReturnType<typeof apiFetch>>;
  function deferred() {
    let resolve!: (v: FetchResult) => void;
    const promise = new Promise<FetchResult>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }
  const draftOk = { ok: true, status: 200, data: { revision: 4, hasDraft: true } } as FetchResult;

  function renderEdit(autosaveEnabled: boolean) {
    render(
      <ArticleForm
        companyId="company-1"
        companyLabel="Acme"
        mode="edit"
        folders={folders}
        article={article}
        autosaveEnabled={autosaveEnabled}
        defaultEditorMode="tiptap"
      />,
    );
  }
  const typeTitle = (value: string) =>
    fireEvent.change(screen.getByPlaceholderText('Article title…'), { target: { value } });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('keeps edits made during a draft save marked unsaved', async () => {
    const first = deferred();
    mockApiFetch.mockReturnValueOnce(first.promise).mockResolvedValue(draftOk);
    renderEdit(false);

    typeTitle('First');
    fireEvent.click(screen.getByRole('button', { name: 'Draft options' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Save draft' }));
    typeTitle('Second'); // typed while the first save is in flight
    await act(async () => first.resolve(draftOk));

    expect(screen.getByText('unsaved')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Draft options' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Save draft' }));
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledTimes(2));
    expect(JSON.parse(String(mockApiFetch.mock.calls[1]![1]?.body))).toMatchObject({
      title: 'Second',
      draft: true,
    });
  });

  it('holds autosave while the Cancel confirm is open, so Discard changes discards', async () => {
    jest.useFakeTimers();
    renderEdit(true);

    typeTitle('Unwanted');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByRole('dialog', { name: 'Discard unsaved changes?' })).toBeInTheDocument();
    act(() => {
      jest.advanceTimersByTime(10_000);
    });
    expect(mockApiFetch).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    await waitFor(() => expect(mockPush).toHaveBeenCalled());
    expect(mockApiFetch).not.toHaveBeenCalled();
  });

  it('lets an autosave in flight land before Cancel decides', async () => {
    jest.useFakeTimers();
    const save = deferred();
    mockApiFetch.mockReturnValueOnce(save.promise);
    renderEdit(true);

    typeTitle('Autosaved');
    await act(async () => {
      jest.advanceTimersByTime(4_000);
    });
    expect(mockApiFetch).toHaveBeenCalledTimes(1); // autosave PATCH in flight

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(mockPush).not.toHaveBeenCalled(); // waits for the save
    await act(async () => save.resolve(draftOk));

    // Everything was saved as the draft, which Cancel keeps: no confirm.
    await waitFor(() => expect(mockPush).toHaveBeenCalled());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(mockApiFetch).toHaveBeenCalledTimes(1);
  });

  it('runs saves one at a time and lets Discard draft wait for all of them', async () => {
    jest.useFakeTimers();
    const autosave = deferred();
    const manual = deferred();
    mockApiFetch
      .mockReturnValueOnce(autosave.promise)
      .mockReturnValueOnce(manual.promise)
      .mockResolvedValue({ ok: true, status: 200, data: {} } as FetchResult);
    render(
      <ArticleForm
        companyId="company-1"
        companyLabel="Acme"
        mode="edit"
        folders={folders}
        article={{ ...article, hasDraft: true, isPublished: true } as ArticleDetail}
        autosaveEnabled
        defaultEditorMode="tiptap"
      />,
    );

    typeTitle('Older');
    await act(async () => {
      jest.advanceTimersByTime(4_000);
    });
    expect(mockApiFetch).toHaveBeenCalledTimes(1); // autosave in flight

    typeTitle('Newer');
    fireEvent.click(screen.getByRole('button', { name: 'Draft options' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Save draft' }));
    await act(async () => {});
    // Queued behind the autosave, never sent alongside it.
    expect(mockApiFetch).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Draft options' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Discard draft' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard draft' }));

    await act(async () => autosave.resolve(draftOk));
    expect(mockApiFetch).toHaveBeenCalledTimes(2); // the manual save runs next
    expect(mockApiFetch.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);

    await act(async () => manual.resolve(draftOk));
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledTimes(3));
    expect(mockApiFetch.mock.calls.map(([, init]) => init?.method)).toEqual([
      'PATCH',
      'PATCH',
      'DELETE',
    ]);
  });

  it('locks a new article while it is being created, and unlocks on failure', async () => {
    const create = deferred();
    mockApiFetch.mockReturnValueOnce(create.promise);
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
    const title = () => screen.getByPlaceholderText('Article title…');

    typeTitle('New article');
    fireEvent.click(screen.getByRole('button', { name: 'Draft options' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Save draft' }));

    // Nothing typed now could reach the page we are about to open.
    expect(title().closest('[inert]')).not.toBeNull();
    await act(async () =>
      create.resolve({ ok: false, status: 500, problem: undefined } as unknown as FetchResult),
    );
    expect(title().closest('[inert]')).toBeNull();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('stays locked after a successful create until the page changes', async () => {
    mockApiFetch.mockResolvedValueOnce({ ok: true, status: 201, data: { id: 'article-9' } } as FetchResult);
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
    typeTitle('New article');
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));

    await waitFor(() =>
      expect(mockPush).toHaveBeenCalledWith('/admin/companies/company-1/articles/article-9'),
    );
    expect(screen.getByPlaceholderText('Article title…').closest('[inert]')).not.toBeNull();
  });
});
