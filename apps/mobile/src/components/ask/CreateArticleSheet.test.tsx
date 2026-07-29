/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ChatToolCallDto } from '@weavestream/shared';
import { fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { initialAskState, type AskState } from './ask-reducer';
import { proposalViews } from './proposal-card';

/**
 * The create confirmation (Phase 5b): org/folder/title/visibility are
 * confirmed BEFORE anything applies, the org rule follows the server
 * contract (turn scope locks; global requires an explicit pick), and a
 * `pendingCreate` recovery marker locks everything to the original
 * confirmation.
 */

const CO = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const FOLDER = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

let askState: AskState = initialAskState;
jest.mock('./AskProvider', () => ({
  useAsk: () => ({ state: askState }),
}));

let foldersResult: { isPending: boolean; data?: unknown[] } = {
  isPending: false,
  data: [],
};
jest.mock('../../features/articles/queries', () => ({
  useArticleFolders: () => foldersResult,
}));

jest.mock('../../features/orgs/use-org-directory', () => ({
  useOrgDirectory: () => ({
    pinned: [],
    rest: [
      { id: 'org-9', name: 'Northwind MSP', initials: 'NM', subtitle: null },
    ],
    loading: false,
    nothingAtAll: false,
    companies: { isError: false, refetch: jest.fn(), hasNextPage: false },
    stars: { isError: false, refetch: jest.fn() },
  }),
}));

jest.mock('../../lib/api', () => ({ apiFetch: jest.fn() }));
const { apiFetch } = jest.requireMock('../../lib/api') as { apiFetch: jest.Mock };

import { CreateArticleSheet } from './CreateArticleSheet';

function render(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return rtlRender(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function createCall(extra: Partial<ChatToolCallDto> = {}): ChatToolCallDto {
  return {
    id: 'tc-1',
    name: 'create_article',
    arguments: {
      title: 'Drafted title',
      markdown: '# Drafted title\n\nBody',
      visible_to_clients: true,
    },
    status: 'pending',
    result: null,
    error: null,
    errorCode: null,
    ...extra,
  } as ChatToolCallDto;
}

function renderSheet(opts: {
  call?: ChatToolCallDto;
  scopeCompanyId?: string | null;
  onSubmit?: jest.Mock;
  onClose?: jest.Mock;
}) {
  const call = opts.call ?? createCall();
  const [view] = proposalViews([call]);
  const onSubmit = opts.onSubmit ?? jest.fn().mockResolvedValue(undefined);
  const onClose = opts.onClose ?? jest.fn();
  const utils = render(
    <CreateArticleSheet
      open
      view={view!}
      scopeCompanyId={opts.scopeCompanyId ?? null}
      onClose={onClose}
      onSubmit={onSubmit}
    />,
  );
  return { onSubmit, onClose, ...utils };
}

beforeEach(() => {
  jest.clearAllMocks();
  askState = initialAskState;
  foldersResult = { isPending: false, data: [] };
  apiFetch.mockResolvedValue({ id: CO, name: 'Acme Dental', archivedAt: null });
});

describe('CreateArticleSheet — org rule', () => {
  it('a company-scoped turn locks the org row (the server applies the turn scope anyway)', async () => {
    const { onSubmit } = renderSheet({ scopeCompanyId: CO });

    await waitFor(() => expect(screen.getByText('Acme Dental')).toBeInTheDocument());
    // No picker affordance — the row is display-only.
    expect(screen.queryByText('Choose organization')).toBeNull();

    // Prefills: title from the LLM args, visibility from the proposal.
    expect(screen.getByPlaceholderText('Article title')).toHaveValue('Drafted title');
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'Create article' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith(CO, {
      title: 'Drafted title',
      folderId: null,
      visibleToClients: true,
    });
  });

  it('a GLOBAL turn requires an explicit org pick before submit enables', async () => {
    const { onSubmit } = renderSheet({ scopeCompanyId: null });

    expect(screen.getByRole('button', { name: 'Create article' })).toBeDisabled();

    fireEvent.click(screen.getByText('Choose organization'));
    fireEvent.click(screen.getByText('Northwind MSP'));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Create article' })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Create article' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('org-9', expect.anything()));
  });
});

describe('CreateArticleSheet — fields and gates', () => {
  it('folders load only once an org exists and flatten with depth markers', async () => {
    foldersResult = {
      isPending: false,
      data: [
        {
          id: FOLDER,
          name: 'Runbooks',
          children: [{ id: 'f2', name: 'Network', children: [] }],
        },
      ] as unknown[],
    };
    renderSheet({ scopeCompanyId: CO });

    await waitFor(() => expect(screen.getByText('Runbooks')).toBeInTheDocument());
    expect(screen.getByText('· Network')).toBeInTheDocument();

    fireEvent.change(screen.getByRole('combobox'), { target: { value: FOLDER } });
    expect(screen.getByRole('combobox')).toHaveValue(FOLDER);
  });

  it('an empty proposal body blocks submit with the honest line', () => {
    renderSheet({
      scopeCompanyId: CO,
      call: createCall({ arguments: { title: 'T', markdown: '' } }),
    });
    expect(screen.getByText('The assistant response is empty.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create article' })).toBeDisabled();
  });

  it('a failed apply keeps the sheet open with the provider error inline', () => {
    askState = {
      ...initialAskState,
      toolActionError: { toolCallId: 'tc-1', message: 'Missing article.write permission.' },
    };
    const { onClose } = renderSheet({ scopeCompanyId: CO });
    expect(screen.getByText('Missing article.write permission.')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('a settle (any device) closes the sheet — the card now tells the truth', () => {
    const onClose = jest.fn();
    renderSheet({
      scopeCompanyId: CO,
      onClose,
      call: createCall({ status: 'applied', result: 'Created article "T".' }),
    });
    expect(onClose).toHaveBeenCalled();
  });
});

describe('CreateArticleSheet — pendingCreate recovery lock', () => {
  const MARKER = {
    articleId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    companyId: CO,
    title: 'Original confirmed title',
    folderId: FOLDER,
    visibleToClients: false,
  };

  it('locks every field to the marker and submits it verbatim', async () => {
    foldersResult = {
      isPending: false,
      data: [{ id: FOLDER, name: 'Runbooks', children: [] }] as unknown[],
    };
    const { onSubmit } = renderSheet({
      scopeCompanyId: null, // even a global turn locks under a marker
      call: createCall({ pendingCreate: MARKER }),
    });

    expect(screen.getByText(/A previous apply didn’t finish/)).toBeInTheDocument();
    const title = screen.getByPlaceholderText('Article title');
    expect(title).toHaveValue(MARKER.title);
    expect(title).toBeDisabled();
    expect(screen.getByRole('switch')).toBeDisabled();
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
    await waitFor(() => expect(screen.getByRole('combobox')).toBeDisabled());
    expect(screen.queryByText('Choose organization')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Create article' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith(CO, {
      title: MARKER.title,
      folderId: MARKER.folderId,
      visibleToClients: MARKER.visibleToClients,
    });
  });
});
