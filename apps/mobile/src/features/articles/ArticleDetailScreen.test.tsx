/**
 * @jest-environment jsdom
 */
import '@testing-library/jest-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { ApiError } from '../../lib/api';
import { ArticleDetailScreen } from './ArticleDetailScreen';
import { makeArticle, makeFolderNode, makeMarkdownArticle } from './test-fixtures';

const ART = 'a0000000-0000-4000-8000-0000000000a1';
const navigateMock = jest.fn();

// Mutable so scope-state tests can override; reset in beforeEach.
let mockScope: {
  currentOrg: unknown;
  scopeStatus: 'resolving' | 'ready' | 'error';
  switchOrg: jest.Mock;
  retry: jest.Mock;
};
function readyScope(): typeof mockScope {
  return {
    currentOrg: {
      id: 'c0000000-0000-4000-8000-0000000000c1',
      name: 'Enterprise Title',
      initials: 'ET',
      subtitle: null,
    },
    scopeStatus: 'ready',
    switchOrg: jest.fn(),
    retry: jest.fn(),
  };
}

jest.mock('../../lib/org-scope', () => ({
  useOrgScope: () => mockScope,
}));
jest.mock('../../lib/scoped-nav', () => ({
  useScopedNavigate: () => navigateMock,
}));
jest.mock('../../lib/use-online', () => ({ useOnline: () => true }));
jest.mock('../../lib/use-back', () => ({
  useBackOr: () => jest.fn(),
  useBackLabel: (label: string) => label,
  // Popping stance: DetailHeader keeps its structural label/target, so
  // pre-5b expectations hold; the Home fallback has its own tests.
  useWillPop: () => true,
}));
jest.mock('../../lib/api', () => {
  const actual = jest.requireActual('../../lib/api');
  return { ...actual, apiFetch: jest.fn() };
});

const { apiFetch } = jest.requireMock('../../lib/api') as { apiFetch: jest.Mock };

const FOLDERS = [
  makeFolderNode({
    id: 'f0000000-0000-4000-8000-0000000000f1',
    name: 'Network',
    children: [
      makeFolderNode({
        id: 'f0000000-0000-4000-8000-0000000000f2',
        name: 'Docs',
        parentId: 'f0000000-0000-4000-8000-0000000000f1',
      }),
    ],
  }),
];

const EMPTY_RELATIONS = { groups: { asset: [], article: [], password: [] } };

function route({
  detail = makeArticle({ id: ART }) as unknown,
  relations = EMPTY_RELATIONS as unknown,
  attachments = { items: [], nextCursor: null } as unknown,
}: { detail?: unknown; relations?: unknown; attachments?: unknown } = {}) {
  apiFetch.mockImplementation((path: string) => {
    if (path.includes('/folders')) return Promise.resolve({ items: FOLDERS });
    if (path.includes('/uploads')) {
      return attachments instanceof Error
        ? Promise.reject(attachments)
        : Promise.resolve(attachments);
    }
    if (path.includes('/relations')) {
      return relations instanceof Error
        ? Promise.reject(relations)
        : Promise.resolve(relations);
    }
    if (path.includes(`/articles/`)) {
      return detail instanceof Error ? Promise.reject(detail) : Promise.resolve(detail);
    }
    return Promise.reject(new Error(`unexpected path ${path}`));
  });
}

function renderDetail(articleId = ART) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return render(
    <Wrapper>
      <ArticleDetailScreen articleId={articleId} />
    </Wrapper>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockScope = readyScope();
  route();
});

describe('ArticleDetailScreen rendering', () => {
  it('renders a tiptap article through the real walker', async () => {
    renderDetail();
    expect(await screen.findByText('Pines site reboot order')).toBeInTheDocument();
    expect(screen.getByText('Core switch first, then the APs.')).toBeInTheDocument();
  });

  it('renders a markdown article through the real MarkdownBody', async () => {
    route({ detail: makeMarkdownArticle({ id: ART }) });
    renderDetail();
    expect(await screen.findByText('snapshot config')).toBeInTheDocument();
    const boxes = document.querySelectorAll('.m-prose input[type="checkbox"]');
    expect(boxes).toHaveLength(2);
    expect(boxes[0]).toBeChecked();
    expect(boxes[0]).toBeDisabled();
  });

  it('badges archived and internal articles', async () => {
    route({
      detail: makeArticle({
        id: ART,
        archivedAt: '2026-07-01T00:00:00.000Z',
        visibleToClients: false,
      }),
    });
    renderDetail();
    expect(await screen.findByText('Archived')).toBeInTheDocument();
    expect(screen.getByText('Internal')).toBeInTheDocument();
  });

  it('shows neither badge for a live, client-visible article', async () => {
    renderDetail();
    await screen.findByText('Pines site reboot order');
    expect(screen.queryByText('Archived')).not.toBeInTheDocument();
    expect(screen.queryByText('Internal')).not.toBeInTheDocument();
  });

  it('renders the article’s attachments, scoped to this article', async () => {
    route({
      attachments: {
        items: [
          {
            id: 'u1',
            filename: 'reboot-checklist.pdf',
            mimeType: 'application/pdf',
            sizeBytes: 4096,
            isImage: false,
            thumbnailUrl: null,
            downloadUrl: '/api/v1/companies/c1/uploads/u1/image',
            createdAt: '2026-07-20T10:00:00.000Z',
          },
        ],
        nextCursor: null,
      },
    });
    renderDetail();

    expect(await screen.findByText('reboot-checklist.pdf')).toBeInTheDocument();
    const call = apiFetch.mock.calls.find((c) =>
      (c[0] as string).includes('/uploads'),
    );
    expect(call![0]).toContain('attachedToType=article');
    expect(call![0]).toContain(`attachedToId=${ART}`);
  });
});

describe('ArticleDetailScreen scope states (deep-link safety)', () => {
  it('surfaces a scope error instead of a permanent skeleton', async () => {
    mockScope = { ...readyScope(), currentOrg: null, scopeStatus: 'error' };
    renderDetail();
    expect(
      await screen.findByText('Couldn’t load your organizations.'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(mockScope.retry).toHaveBeenCalled();
  });

  it('shows the no-organizations empty state when scope resolves to none', () => {
    mockScope = { ...readyScope(), currentOrg: null, scopeStatus: 'ready' };
    renderDetail();
    expect(screen.getByText(/No organizations available/)).toBeInTheDocument();
    expect(apiFetch).not.toHaveBeenCalled();
  });
});

describe('ArticleDetailScreen invalid id (wrapper guard)', () => {
  it('renders not-found for a malformed deep link with zero requests', () => {
    renderDetail('abc');
    expect(screen.getByText(/wasn’t found/)).toBeInTheDocument();
    expect(apiFetch).not.toHaveBeenCalled();
  });
});

describe('ArticleDetailScreen error branches', () => {
  it('404 renders the ambiguous not-found state', async () => {
    route({ detail: new ApiError(404, null) });
    renderDetail();
    expect(await screen.findByText(/wasn’t found/)).toBeInTheDocument();
  });

  it('plain 403 renders the restricted banner without a retry', async () => {
    route({ detail: new ApiError(403, { detail: 'nope' }) });
    renderDetail();
    expect(
      await screen.findByText('You don’t have access to this article.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('500 renders the generic banner with retry', async () => {
    route({ detail: new ApiError(500, null) });
    renderDetail();
    expect(await screen.findByText('Couldn’t load this article.')).toBeInTheDocument();

    route();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Pines site reboot order')).toBeInTheDocument();
  });
});

describe('ArticleDetailScreen metadata (ShowMore)', () => {
  it('reveals folder breadcrumb, updated, and created rows', async () => {
    route({
      detail: makeArticle({ id: ART, folderId: 'f0000000-0000-4000-8000-0000000000f2' }),
    });
    renderDetail();
    await screen.findByText('Pines site reboot order');

    fireEvent.click(screen.getByRole('button', { name: /Show more/ }));
    expect(await screen.findByText('Network / Docs')).toBeInTheDocument();
    expect(screen.getByText('Folder')).toBeInTheDocument();
    // Updated and Created both resolve the actor name.
    expect(screen.getAllByText(/· A\. Reyes/)).toHaveLength(2);
    expect(screen.getByText('Created')).toBeInTheDocument();
  });
});

describe('ArticleDetailScreen related items', () => {
  it('navigates to a related article', async () => {
    route({
      relations: {
        groups: {
          asset: [],
          password: [],
          article: [
            {
              relationId: 'r1',
              kind: 'article',
              id: 'a0000000-0000-4000-8000-0000000000a9',
              title: 'Companion runbook',
              subtitle: null,
            },
          ],
        },
      },
    });
    renderDetail();
    fireEvent.click(await screen.findByRole('button', { name: /Companion runbook/ }));
    expect(navigateMock).toHaveBeenCalledWith({
      to: '/articles/a0000000-0000-4000-8000-0000000000a9',
    });
  });
});
