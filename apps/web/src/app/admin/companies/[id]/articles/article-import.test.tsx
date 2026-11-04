/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { suffixedArticleIdentity } from '@weavestream/shared';
import { ToastProvider } from '../../../../../components/ui';
import { apiFetch } from '../../../../../lib/api';
import { ArticleImportButton } from './article-import';

const mockRefresh = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), refresh: mockRefresh }),
}));

jest.mock('../../../../../lib/api', () => ({ apiFetch: jest.fn() }));
const mockApiFetch = apiFetch as jest.MockedFunction<typeof apiFetch>;

const ok = { ok: true, status: 201, data: { id: 'new-id' }, problem: null };

function md(name: string, text: string) {
  return new File([text], name, { type: 'text/markdown' });
}

function bodyOf(call: number) {
  const init = mockApiFetch.mock.calls[call]![1] as { body: string };
  return JSON.parse(init.body) as Record<string, unknown>;
}

function setup(folderId: string | null = 'folder-1') {
  render(
    <ToastProvider>
      <ArticleImportButton
        companyId="company-1"
        folderId={folderId}
        folderName={folderId ? 'Runbooks' : null}
      />
    </ToastProvider>,
  );
}

async function pick(...files: File[]) {
  const input = screen.getByTestId('article-import-input');
  await act(async () => {
    fireEvent.change(input, { target: { files } });
  });
  await screen.findByRole('dialog');
}

beforeEach(() => {
  mockApiFetch.mockReset();
  mockRefresh.mockReset();
});

describe('ArticleImportButton', () => {
  it('sends the folder id and visibleToClients from the checkbox', async () => {
    mockApiFetch.mockResolvedValue(ok);
    setup();
    await pick(md('a.md', '# Alpha\n\nBody A'));
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText(/Into folder:/)).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/Visible to clients/));
    fireEvent.click(screen.getByRole('button', { name: 'Import 1 article' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(mockApiFetch).toHaveBeenCalledWith('/companies/company-1/articles', expect.anything());
    expect(bodyOf(0)).toEqual({
      title: 'Alpha',
      folderId: 'folder-1',
      visibleToClients: true,
      editorMode: 'markdown',
      markdownSource: 'Body A',
    });
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it('defaults to hidden from clients and omits folderId with no folder', async () => {
    mockApiFetch.mockResolvedValue(ok);
    setup(null);
    await pick(md('b.md', 'Plain text'));
    expect(screen.getByText(/Into: No folder/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Import 1 article' }));
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledTimes(1));
    const body = bodyOf(0);
    expect(body.visibleToClients).toBe(false);
    expect('folderId' in body).toBe(false);
    expect(body.title).toBe('b');
  });

  it('retries a slug conflict with an explicit suffixed slug and title', async () => {
    const long = 'L'.repeat(200);
    mockApiFetch
      .mockResolvedValueOnce({ ok: false, status: 409, data: null, problem: { error: 'SlugTaken' } })
      .mockResolvedValueOnce(ok);
    setup();
    await pick(md('c.md', `# ${long}\n\nBody`));
    fireEvent.click(screen.getByRole('button', { name: 'Import 1 article' }));
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledTimes(2));
    expect(bodyOf(0).slug).toBeUndefined();
    const expected = suffixedArticleIdentity(long, 2);
    expect(bodyOf(1).slug).toBe(expected.slug);
    expect(bodyOf(1).title).toBe(expected.title);
    expect((bodyOf(1).title as string).length).toBeLessThanOrEqual(200);
  });

  it('stops on 429 and marks later files not imported', async () => {
    mockApiFetch
      .mockResolvedValueOnce(ok)
      .mockResolvedValueOnce({ ok: false, status: 429, data: null, problem: { message: 'Slow down' } });
    setup();
    await pick(md('1.md', '# One\nx'), md('2.md', '# Two\nx'), md('3.md', '# Three\nx'));
    fireEvent.click(screen.getByRole('button', { name: 'Import 3 articles' }));
    await screen.findByRole('status');
    expect(mockApiFetch).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('status')).toHaveTextContent(
      '1 imported, 1 failed, 1 not imported, 0 uncertain',
    );
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it('recovers when a request throws after an earlier success', async () => {
    mockApiFetch.mockResolvedValueOnce(ok).mockRejectedValueOnce(new TypeError('Failed to fetch'));
    setup();
    await pick(md('1.md', '# One\nx'), md('2.md', '# Two\nx'), md('3.md', '# Three\nx'));
    fireEvent.click(screen.getByRole('button', { name: 'Import 3 articles' }));
    await screen.findByRole('status');
    expect(screen.getByRole('status')).toHaveTextContent(
      '1 imported, 0 failed, 1 not imported, 1 uncertain',
    );
    expect(screen.getByText(/may have been created/)).toBeInTheDocument();
    // Run finished: only Close is offered, and it works.
    expect(screen.queryByRole('button', { name: /Cancel/ })).not.toBeInTheDocument();
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('cannot be dismissed while a request is in flight', async () => {
    let resolve!: (v: typeof ok) => void;
    mockApiFetch.mockReturnValueOnce(new Promise((r) => (resolve = r)) as never);
    setup();
    await pick(md('a.md', '# Alpha\nx'));
    fireEvent.click(screen.getByRole('button', { name: 'Import 1 article' }));
    await screen.findByText(/Importing 1 of 1/);

    fireEvent.keyDown(document, { key: 'Escape' });
    const overlay = screen.getByRole('dialog').parentElement!;
    fireEvent.mouseDown(overlay);
    fireEvent.mouseUp(overlay);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^Import$/ })).toBeDisabled();

    await act(async () => resolve(ok));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('rejects non-Markdown files without sending them', async () => {
    setup();
    await pick(md('notes.txt', 'hello'));
    expect(screen.getByText(/Not a \.md file/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import 0 articles' })).toBeDisabled();
  });
});
