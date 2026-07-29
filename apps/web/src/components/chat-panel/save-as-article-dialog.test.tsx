/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ChatPendingCreate } from '@weavestream/shared';
import { SaveAsArticleDialog } from './save-as-article-dialog';

/**
 * Create-recovery lock (Phase 5b rev-4): when a tool call carries a
 * `pendingCreate` marker, a prior apply crashed after creating the
 * article — the ORIGINAL confirmation is the only one the server will
 * complete, and mismatched retries are rejected with the stable
 * `ARTICLE_CREATE_RECOVERY_PENDING_CODE`. The dialog must therefore
 * lock every field to the marker and submit those values verbatim,
 * instead of reinitializing from LLM args / page context (which after
 * a reload could only ever produce mismatched retries).
 *
 * The narrower company lock is the same idea one level down: on a
 * company-scoped turn the server binds the create to that scope and
 * refuses a differing confirmed destination, so the picker must not
 * offer one — but title / folder / visibility remain the user's call.
 */

const push = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh: jest.fn(), replace: jest.fn() }),
}));

const toastPush = jest.fn();
jest.mock('../ui', () => {
  const actual = jest.requireActual('../ui') as Record<string, unknown>;
  return {
    ...actual,
    useToast: () => ({ push: toastPush }),
    // The picker pulls provider-backed search machinery irrelevant here;
    // locked mode never renders it, and free mode isn't under test.
    CompanyPicker: () => <div data-testid="company-picker" />,
  };
});

jest.mock('../../lib/api', () => ({ apiFetch: jest.fn() }));
const { apiFetch } = jest.requireMock('../../lib/api') as { apiFetch: jest.Mock };

const MARKER: ChatPendingCreate = {
  articleId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  companyId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  title: 'Original confirmed title',
  folderId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
  visibleToClients: true,
};

function routeApi() {
  apiFetch.mockImplementation((path: string) => {
    if (path === `/companies/${MARKER.companyId}`) {
      return Promise.resolve({
        ok: true,
        data: {
          id: MARKER.companyId,
          name: 'Northwind MSP',
          slug: 'northwind',
          archivedAt: null,
        },
      });
    }
    if (path === `/companies/${MARKER.companyId}/folders/tree`) {
      return Promise.resolve({
        ok: true,
        data: {
          items: [{ id: MARKER.folderId, name: 'Runbooks', children: [] }],
        },
      });
    }
    return Promise.resolve({ ok: false, problem: null });
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  routeApi();
});

describe('SaveAsArticleDialog — destination locks', () => {
  it('locks title/company/folder/visibility to the marker and submits them verbatim', async () => {
    const applyToolCall = jest.fn().mockResolvedValue({ ok: true });
    render(
      <SaveAsArticleDialog
        open
        markdown={'# LLM title\n\nBody'}
        defaultCompanyId={null}
        defaultTitle="LLM title"
        defaultVisibleToClients={false}
        pendingCreate={MARKER}
        applyToolCall={applyToolCall}
        onClose={jest.fn()}
      />,
    );

    expect(
      screen.getByText(/A previous apply didn’t finish/),
    ).toBeInTheDocument();

    // Title is the MARKER's, not the LLM default, and cannot be edited.
    const titleInput = screen.getByPlaceholderText('Article title');
    expect(titleInput).toHaveValue(MARKER.title);
    expect(titleInput).toBeDisabled();

    // The company is the marker's, shown fixed — no picker.
    await waitFor(() =>
      expect(screen.getByDisplayValue('Northwind MSP')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('company-picker')).not.toBeInTheDocument();

    // Folder select locked to the marker's folder; visibility locked on.
    await waitFor(() => expect(screen.getByText('Runbooks')).toBeInTheDocument());
    expect(screen.getByRole('combobox')).toBeDisabled();
    expect(screen.getByRole('combobox')).toHaveValue(MARKER.folderId);
    const checkbox = screen.getByRole('checkbox');
    expect(checkbox).toBeChecked();
    expect(checkbox).toBeDisabled();

    fireEvent.click(screen.getByText('Create article'));

    await waitFor(() => expect(applyToolCall).toHaveBeenCalledTimes(1));
    expect(applyToolCall).toHaveBeenCalledWith({
      companyId: MARKER.companyId,
      title: MARKER.title,
      folderId: MARKER.folderId,
      visibleToClients: MARKER.visibleToClients,
    });
  });

  it('a company-scoped turn locks ONLY the company — title/folder/visibility stay editable', async () => {
    // Apply binds the create to the turn's scope and refuses a differing
    // confirmed destination, so offering a picker here would lie. The
    // rest of the confirmation is still the user's to make.
    const applyToolCall = jest.fn().mockResolvedValue({ ok: true });
    render(
      <SaveAsArticleDialog
        open
        markdown={'# LLM title\n\nBody'}
        defaultCompanyId={null}
        defaultTitle="LLM title"
        lockedCompanyId={MARKER.companyId}
        applyToolCall={applyToolCall}
        onClose={jest.fn()}
      />,
    );

    // No recovery banner — this is not a crashed apply.
    expect(screen.queryByText(/A previous apply didn’t finish/)).not.toBeInTheDocument();

    await waitFor(() =>
      expect(screen.getByDisplayValue('Northwind MSP')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('company-picker')).not.toBeInTheDocument();

    const titleInput = screen.getByPlaceholderText('Article title');
    expect(titleInput).not.toBeDisabled();
    await waitFor(() => expect(screen.getByText('Runbooks')).toBeInTheDocument());
    expect(screen.getByRole('combobox')).not.toBeDisabled();
    expect(screen.getByRole('checkbox')).not.toBeDisabled();

    fireEvent.change(titleInput, { target: { value: 'My own title' } });
    fireEvent.click(screen.getByText('Create article'));

    await waitFor(() => expect(applyToolCall).toHaveBeenCalledTimes(1));
    expect(applyToolCall).toHaveBeenCalledWith({
      companyId: MARKER.companyId,
      title: 'My own title',
      folderId: null,
      visibleToClients: false,
    });
  });

  it('submits the locked company even when its name lookup fails', async () => {
    // The name fetch is display-only; a blip must not disable an Apply
    // the server would accept.
    apiFetch.mockImplementation((path: string) =>
      path === `/companies/${MARKER.companyId}/folders/tree`
        ? Promise.resolve({ ok: true, data: { items: [] } })
        : Promise.resolve({ ok: false, problem: null }),
    );
    const applyToolCall = jest.fn().mockResolvedValue({ ok: true });
    render(
      <SaveAsArticleDialog
        open
        markdown={'# LLM title\n\nBody'}
        defaultCompanyId={null}
        defaultTitle="LLM title"
        lockedCompanyId={MARKER.companyId}
        applyToolCall={applyToolCall}
        onClose={jest.fn()}
      />,
    );

    fireEvent.click(screen.getByText('Create article'));

    await waitFor(() => expect(applyToolCall).toHaveBeenCalledTimes(1));
    expect(applyToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: MARKER.companyId }),
    );
  });

  it('without a marker, the free-form dialog keeps its LLM defaults and editable fields', () => {
    render(
      <SaveAsArticleDialog
        open
        markdown={'# LLM title\n\nBody'}
        defaultCompanyId={null}
        defaultTitle="LLM title"
        onClose={jest.fn()}
      />,
    );

    const titleInput = screen.getByPlaceholderText('Article title');
    expect(titleInput).toHaveValue('LLM title');
    expect(titleInput).not.toBeDisabled();
    expect(screen.getByTestId('company-picker')).toBeInTheDocument();
    expect(screen.queryByText(/A previous apply didn’t finish/)).not.toBeInTheDocument();
  });
});
