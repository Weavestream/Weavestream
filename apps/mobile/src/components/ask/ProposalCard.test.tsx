/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ChatToolCallDto } from '@weavestream/shared';
import { fireEvent, render as rtlRender, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

/** The org-chip lookup pulls TanStack Query. */
function render(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return rtlRender(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}
import type { AskMessage } from './ask-reducer';
import { initialAskState, type AskState } from './ask-reducer';
import { proposalViews } from './proposal-card';

/**
 * The Phase 5b render matrix: every server lifecycle state and every
 * Apply gate. The invariant under test throughout: **never apply a
 * proposal the user cannot preview, and never present a failed apply
 * as success.**
 */

const ART = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CO = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const applyMock = jest.fn();
const rejectMock = jest.fn();
let askState: AskState = initialAskState;

jest.mock('./AskProvider', () => ({
  useAsk: () => ({
    state: askState,
    setDraft: jest.fn(),
    send: jest.fn(),
    stop: jest.fn(),
    newChat: jest.fn(),
    applyToolCall: applyMock,
    rejectToolCall: rejectMock,
  }),
}));

let currentOrg: { id: string } | null = null;
jest.mock('../../lib/org-scope', () => ({
  useOrgScope: () => ({ currentOrg, scopeStatus: 'ready' }),
}));

type DetailResult = {
  isPending: boolean;
  isError: boolean;
  data?: {
    title: string;
    editorMode: string;
    markdownSource: string | null;
    content?: unknown;
    revision: number;
  };
};
let detailResult: DetailResult = { isPending: true, isError: false };
const useArticleDetailMock = jest.fn((..._args: unknown[]) => detailResult);
jest.mock('../../features/articles/queries', () => ({
  useArticleDetail: (...args: unknown[]) => useArticleDetailMock(...args),
}));

// Company-name chip: keep it silent (never resolves).
jest.mock('../../lib/api', () => ({ apiFetch: jest.fn(() => new Promise(() => {})) }));

// The sheet has its own suite; here it only needs to prove it opened.
jest.mock('./CreateArticleSheet', () => ({
  CreateArticleSheet: ({ open }: { open: boolean }) =>
    open ? <div data-testid="create-sheet" /> : null,
}));

import { ProposalCard } from './ProposalCard';

function call(over: Partial<ChatToolCallDto> & { name: string }): ChatToolCallDto {
  return {
    id: 'tc-1',
    arguments: {},
    status: 'pending',
    result: null,
    error: null,
    errorCode: null,
    ...over,
  } as ChatToolCallDto;
}

function renderCard(
  toolCall: ChatToolCallDto,
  opts: { serverMessageId?: string | null; scopeCompanyId?: string | null } = {},
) {
  const [view] = proposalViews([toolCall]);
  const message: AskMessage = {
    clientId: 'a1',
    role: 'assistant',
    text: 'Drafted.',
    state: 'done',
    notices: [],
    toolCalls: [toolCall],
    serverMessageId: opts.serverMessageId === undefined ? 'm1' : opts.serverMessageId,
    scopeCompanyId: opts.scopeCompanyId ?? null,
  };
  return render(<ProposalCard view={view!} message={message} />);
}

const applyBtn = () => screen.getByRole('button', { name: /apply|loading preview/i });
const rejectBtn = () => screen.getByRole('button', { name: /reject/i });

beforeEach(() => {
  jest.clearAllMocks();
  askState = initialAskState;
  currentOrg = null;
  detailResult = { isPending: true, isError: false };
});

const READY_BASE: DetailResult = {
  isPending: false,
  isError: false,
  data: {
    title: 'Old title',
    editorMode: 'markdown',
    markdownSource: 'Before\n\nOld text\n\nAfter',
    revision: 3,
  },
};

describe('ProposalCard — pending patch ladder', () => {
  const patch = () =>
    call({
      name: 'patch_article',
      arguments: {
        article_id: ART,
        edits: [{ old_text: 'Old text', new_text: 'New text' }],
      },
      baseRevision: 3,
      targetCompanyId: CO,
    });

  it('no previewCompanyId (global Ask, no hint) → unavailable, Apply disabled', () => {
    renderCard(call({ ...patch(), targetCompanyId: undefined } as never));
    expect(
      screen.getByText('The target article is unavailable for preview.'),
    ).toBeInTheDocument();
    expect(applyBtn()).toBeDisabled();
  });

  it('base loading → Apply disabled with the loading label', () => {
    renderCard(patch());
    expect(screen.getByText('Loading article preview…')).toBeInTheDocument();
    expect(applyBtn()).toBeDisabled();
  });

  it('fetch failure → safe-preview error, Apply disabled', () => {
    detailResult = { isPending: false, isError: true };
    renderCard(patch());
    expect(
      screen.getByText('The article could not be loaded for a safe preview.'),
    ).toBeInTheDocument();
    expect(applyBtn()).toBeDisabled();
  });

  it('revision mismatch (client-side stale) → Apply disabled', () => {
    detailResult = {
      ...READY_BASE,
      data: { ...READY_BASE.data!, revision: 4 },
    };
    renderCard(patch());
    expect(screen.getByText(/changed after this proposal was drafted/)).toBeInTheDocument();
    expect(applyBtn()).toBeDisabled();
  });

  it('ready → diff renders and Apply fires WITHOUT a companyId', () => {
    detailResult = READY_BASE;
    renderCard(patch());
    expect(screen.getByText('New text')).toBeInTheDocument();
    const apply = applyBtn();
    expect(apply).toBeEnabled();
    fireEvent.click(apply);
    expect(applyMock).toHaveBeenCalledWith('m1', 'tc-1');
    fireEvent.click(rejectBtn());
    expect(rejectMock).toHaveBeenCalledWith('m1', 'tc-1');
  });

  it('the global preview uses targetCompanyId when no org is selected', () => {
    detailResult = READY_BASE;
    renderCard(patch());
    expect(useArticleDetailMock).toHaveBeenCalledWith(CO, ART);
  });

  it('a rich-text base with edits warns about the Markdown conversion', () => {
    detailResult = {
      isPending: false,
      isError: false,
      data: {
        title: 'Old',
        editorMode: 'tiptap',
        markdownSource: null,
        content: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Old text' }] }],
        },
        revision: 3,
      },
    };
    renderCard(patch());
    expect(
      screen.getByText('Applying converts this rich-text article to Markdown formatting.'),
    ).toBeInTheDocument();
  });
});

describe('ProposalCard — pending update shapes', () => {
  it('a body rewrite diffs against the fetched base once ready', () => {
    detailResult = READY_BASE;
    renderCard(
      call({
        name: 'update_article',
        arguments: { article_id: ART, markdown: '# New title\n\nNew body' },
        baseRevision: 3,
        targetCompanyId: CO,
      }),
    );
    expect(screen.getByText('New body')).toBeInTheDocument();
    expect(applyBtn()).toBeEnabled();
  });

  it('a heading-promoted title change is PREVIEWED, never applied undisclosed', () => {
    // No explicit `title` arg — the server promotes the leading
    // `# Heading` to the article title on apply; the card must say so.
    detailResult = READY_BASE; // base title: "Old title"
    renderCard(
      call({
        name: 'update_article',
        arguments: { article_id: ART, markdown: '# New title\n\nNew body' },
        baseRevision: 3,
        targetCompanyId: CO,
      }),
    );
    expect(screen.getByText(/Title change:.*Old title.*New title/)).toBeInTheDocument();
    expect(screen.getByText('New body')).toBeInTheDocument();
  });

  it('no title line when the heading matches the current title', () => {
    detailResult = READY_BASE;
    renderCard(
      call({
        name: 'update_article',
        arguments: { article_id: ART, markdown: '# Old title\n\nNew body' },
        baseRevision: 3,
        targetCompanyId: CO,
      }),
    );
    expect(screen.queryByText(/Title change:/)).toBeNull();
  });

  it('TITLE-ONLY updates ride the same ladder: unfetchable → disabled (P1-3)', () => {
    renderCard(
      call({
        name: 'update_article',
        arguments: { article_id: ART, title: 'Renamed' },
        baseRevision: 3,
        // No targetCompanyId, no org → unfetchable.
      }),
    );
    expect(
      screen.getByText('The target article is unavailable for preview.'),
    ).toBeInTheDocument();
    expect(applyBtn()).toBeDisabled();
  });

  it('title-only + fetched base at the matching revision → previewable and enabled', () => {
    detailResult = READY_BASE;
    renderCard(
      call({
        name: 'update_article',
        arguments: { article_id: ART, title: 'Renamed' },
        baseRevision: 3,
        targetCompanyId: CO,
      }),
    );
    expect(screen.getByText(/Title change:/)).toBeInTheDocument();
    expect(screen.getByText('Body unchanged.')).toBeInTheDocument();
    expect(applyBtn()).toBeEnabled();
  });

  it('markdown AND title both absent → "no changes", Apply disabled', () => {
    detailResult = READY_BASE;
    renderCard(
      call({
        name: 'update_article',
        arguments: { article_id: ART },
        baseRevision: 3,
        targetCompanyId: CO,
      }),
    );
    expect(
      screen.getByText('The proposed edit does not contain any changes.'),
    ).toBeInTheDocument();
    expect(applyBtn()).toBeDisabled();
  });

  it('a body-less hallucinated target cannot promote: Apply disabled', () => {
    renderCard(
      call({
        name: 'update_article',
        arguments: { article_id: ART, title: 'Rename' },
        baseRevision: null,
      }),
    );
    expect(
      screen.getByText('This proposal was not based on a confirmed article revision.'),
    ).toBeInTheDocument();
    expect(applyBtn()).toBeDisabled();
  });
});

describe('ProposalCard — create flow and busy discipline', () => {
  const create = () =>
    call({
      name: 'create_article',
      arguments: { title: 'Runbook', markdown: '# Runbook\n\nBody' },
    });

  it('a pending create opens the confirmation sheet instead of applying inline', () => {
    renderCard(create());
    expect(screen.queryByTestId('create-sheet')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Apply…' }));
    expect(applyMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('create-sheet')).toBeInTheDocument();
  });

  it('ANY in-flight tool action disables every card (global single-flight)', () => {
    askState = {
      ...initialAskState,
      toolAction: { toolCallId: 'other-call', kind: 'apply' },
    };
    detailResult = READY_BASE;
    renderCard(create());
    expect(screen.getByRole('button', { name: 'Apply…' })).toBeDisabled();
    expect(rejectBtn()).toBeDisabled();
  });

  it('the transient action error keeps the card pending with the message inline', () => {
    askState = {
      ...initialAskState,
      toolActionError: { toolCallId: 'tc-1', message: 'Couldn’t apply the change.' },
    };
    renderCard(create());
    expect(screen.getByText('Couldn’t apply the change.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply…' })).toBeEnabled();
  });
});

describe('ProposalCard — settled states', () => {
  it('applied renders the server result (create keeps the draft recoverable)', () => {
    renderCard(
      call({
        name: 'create_article',
        arguments: { title: 'T', markdown: '# T\n\nBody' },
        status: 'applied',
        result: 'Created article "T".',
      }),
    );
    expect(screen.getByText('Created article "T".')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show draft' }));
    expect(screen.getByText('Body')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /apply/i })).toBeNull();
  });

  it('rejected is a muted terminal row', () => {
    renderCard(call({ name: 'patch_article', status: 'rejected' }));
    expect(screen.getByText('Rejected.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /apply/i })).toBeNull();
  });

  it('soft failures (stale) show the server text without a Failed prefix', () => {
    renderCard(
      call({
        name: 'patch_article',
        status: 'failed',
        errorCode: 'stale',
        error: 'This article was edited after the proposal was drafted.',
      }),
    );
    expect(
      screen.getByText('This article was edited after the proposal was drafted.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/^Failed:/)).toBeNull();
  });

  it('errorCode null is the HARD bucket (permission denial / generic)', () => {
    renderCard(
      call({
        name: 'patch_article',
        status: 'failed',
        errorCode: null,
        error: 'Missing article.write permission.',
      }),
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Failed: Missing article.write permission.',
    );
  });
});
