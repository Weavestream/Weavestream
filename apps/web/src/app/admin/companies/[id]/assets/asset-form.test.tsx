/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FILE_MULTI_CAP } from '@weavestream/shared';
import type { LayoutFieldSummary, LayoutSummary } from '../../../../../lib/server-api';
import { ToastProvider } from '../../../../../components/ui';
import { AssetForm } from './asset-form';

/**
 * 5a parity matrix — the desktop mirror of mobile's
 * `FileFieldEditor.test.tsx`. Every cell here has a counterpart pin in
 * the mobile suite (or the API `FileStrategy` describe), so the two
 * editors are asserted against the same contract: absent `multiple`
 * means single, single mode replaces and supersedes, commits survive
 * same-tick confirms, the 100-cap room check truncates, `accept` and
 * `maxSizeMb` gate before upload, uploads never carry an attachment id,
 * and in-flight uploads gate Save.
 */

const push = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh: jest.fn(), replace: jest.fn() }),
}));
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({
    href,
    children,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
    href: string;
    children: React.ReactNode;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));
// The real TopBar pulls provider-backed hooks (search palette, sticky
// note, shell scope) that are irrelevant here — but its `right` prop
// carries the form's Save/Cancel buttons, so the stub must render it.
jest.mock('../../../../../components/shell/top-bar', () => ({
  TopBar: ({ right }: { right?: React.ReactNode }) => <>{right}</>,
}));
// Mock ONLY uploadFile — preflightFile/describeUploadError stay real so
// the size gate and failure copy under test are the shipped ones.
jest.mock('../../../../../lib/upload-client', () => {
  const actual = jest.requireActual('../../../../../lib/upload-client');
  return { ...actual, uploadFile: jest.fn() };
});
// Submit hangs forever so the save-in-progress state is observable.
jest.mock('../../../../../lib/api', () => ({
  apiFetch: jest.fn(() => new Promise(() => {})),
}));
const { uploadFile } = jest.requireMock('../../../../../lib/upload-client') as {
  uploadFile: jest.Mock;
};

function fileField(options: Record<string, unknown>): LayoutFieldSummary {
  return {
    id: 'f-files',
    name: 'Files',
    slug: 'files',
    fieldType: 'FILE',
    position: 1,
    isRequired: false,
    isUniquePerCompany: false,
    visibleToClients: true,
    isPrimary: false,
    showInTable: false,
    options,
    archivedAt: null,
  };
}

function layoutWith(options: Record<string, unknown>): LayoutSummary {
  return {
    id: 'l-1',
    name: 'Devices',
    slug: 'devices',
    icon: 'server',
    color: '#3b6ef5',
    isActive: true,
    version: 1,
    position: 0,
    archivedAt: null,
    createdBy: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    fields: [fileField(options)],
  };
}

const oldEntry = (uploadId = 'u-old', filename = 'old.pdf') => ({
  uploadId,
  filename,
  mimeType: 'application/pdf',
  sizeBytes: 100,
});

function confirmResponse(id: string, filename: string) {
  return {
    id,
    companyId: 'co-1',
    filename,
    mimeType: 'application/pdf',
    sizeBytes: 2048,
    isImage: false,
    width: null,
    height: null,
    thumbnailUrl: null,
    downloadUrl: `/dl/${id}`,
    createdAt: '2026-07-28T10:00:00.000Z',
  };
}

function renderForm(
  options: Record<string, unknown>,
  initialValues?: Record<string, unknown>,
) {
  return render(
    <ToastProvider>
      <AssetForm
        companyId="co-1"
        companyLabel="Acme Corp"
        layout={layoutWith(options)}
        mode="edit"
        assetId="a-1"
        initialName="Server 1"
        initialValues={initialValues}
      />
    </ToastProvider>,
  );
}

function fileInput(): HTMLInputElement {
  const input = document.querySelector('input[type="file"]');
  if (!input) throw new Error('file input not found');
  return input as HTMLInputElement;
}

function pdf(name: string, bytes = 8): File {
  return new File([new Uint8Array(bytes)], name, { type: 'application/pdf' });
}

function pickFiles(files: File[]) {
  fireEvent.change(fileInput(), { target: { files } });
}

function saveButton(): HTMLElement {
  return screen.getByRole('button', { name: /Save asset/ });
}

beforeEach(() => {
  jest.clearAllMocks();
  uploadFile.mockResolvedValue(confirmResponse('u-new', 'new.pdf'));
});

describe('multiplicity (server mirror: absent/false ⇒ single, true ⇒ multi)', () => {
  it('multiple absent ⇒ single: no input attr, "single file" caption, replace-not-append', async () => {
    renderForm({}, { files: [oldEntry()] });
    expect(fileInput()).not.toHaveAttribute('multiple');
    expect(screen.getByText('single file')).toBeInTheDocument();
    expect(screen.getByText('old.pdf')).toBeInTheDocument();

    await act(async () => {
      pickFiles([pdf('new.pdf')]);
    });
    await waitFor(() => expect(screen.getByText('new.pdf')).toBeInTheDocument());
    // Replace semantics: the previous entry is gone, one tile remains.
    expect(screen.queryByText('old.pdf')).not.toBeInTheDocument();
    expect(screen.getAllByTitle('Remove')).toHaveLength(1);
  });

  it('multiple === false follows the same single path', async () => {
    renderForm({ multiple: false }, { files: [oldEntry()] });
    expect(fileInput()).not.toHaveAttribute('multiple');

    await act(async () => {
      pickFiles([pdf('new.pdf')]);
    });
    await waitFor(() => expect(screen.getByText('new.pdf')).toBeInTheDocument());
    expect(screen.queryByText('old.pdf')).not.toBeInTheDocument();
    expect(screen.getAllByTitle('Remove')).toHaveLength(1);
  });

  it('multiple === true sets the input attr, shows "multi-upload", and APPENDS to a seeded entry', async () => {
    renderForm({ multiple: true }, { files: [oldEntry()] });
    expect(fileInput()).toHaveAttribute('multiple');
    expect(screen.getByText('multi-upload')).toBeInTheDocument();

    await act(async () => {
      pickFiles([pdf('new.pdf')]);
    });
    await waitFor(() => expect(screen.getByText('new.pdf')).toBeInTheDocument());
    expect(screen.getByText('old.pdf')).toBeInTheDocument();
    expect(screen.getAllByTitle('Remove')).toHaveLength(2);
  });
});

describe('single-mode pick semantics', () => {
  it('truncates a multi-file drop to the FIRST file — exactly one upload', async () => {
    renderForm({});
    await act(async () => {
      pickFiles([pdf('first.pdf'), pdf('second.pdf')]);
    });
    await waitFor(() => expect(uploadFile).toHaveBeenCalledTimes(1));
    expect((uploadFile.mock.calls[0]![0] as { file: File }).file.name).toBe('first.pdf');
  });

  it('a new pick SUPERSEDES an in-flight upload — the older aborts silently and never commits', async () => {
    const gates: Array<{ resolve: (v: unknown) => void; signal: AbortSignal }> = [];
    uploadFile.mockImplementation(
      (opts: { signal: AbortSignal }) =>
        new Promise((resolve, reject) => {
          gates.push({ resolve, signal: opts.signal });
          opts.signal.addEventListener(
            'abort',
            () => reject(new DOMException('The operation was aborted.', 'AbortError')),
            { once: true },
          );
        }),
    );
    renderForm({});

    await act(async () => {
      pickFiles([pdf('slow.pdf')]);
    });
    await act(async () => {
      pickFiles([pdf('newer.pdf')]);
    });

    expect(gates[0]!.signal.aborted).toBe(true);
    expect(gates[1]!.signal.aborted).toBe(false);

    await act(async () => {
      gates[1]!.resolve(confirmResponse('u-newer', 'newer.pdf'));
    });
    await waitFor(() => expect(screen.getByText('newer.pdf')).toBeInTheDocument());
    // The superseded upload vanished without an error row or alert.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getAllByTitle('Remove')).toHaveLength(1);
  });

  it('the Cancel affordance aborts an in-flight upload silently', async () => {
    uploadFile.mockImplementation(
      (opts: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          opts.signal.addEventListener(
            'abort',
            () => reject(new DOMException('The operation was aborted.', 'AbortError')),
            { once: true },
          );
        }),
    );
    renderForm({});
    await act(async () => {
      pickFiles([pdf('doomed.pdf')]);
    });
    expect(saveButton()).toBeDisabled();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel upload of doomed.pdf' }));
    });
    await waitFor(() => expect(saveButton()).toBeEnabled());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByTitle('Remove')).not.toBeInTheDocument();
  });
});

describe('overlapping commits (valueRef, not the stale prop)', () => {
  it('two batches confirming in the same tick both land', async () => {
    const gates: Array<(v: unknown) => void> = [];
    uploadFile.mockImplementation(() => new Promise((resolve) => gates.push(resolve)));
    renderForm({ multiple: true });

    await act(async () => {
      pickFiles([pdf('a.pdf')]);
    });
    await act(async () => {
      pickFiles([pdf('b.pdf')]);
    });

    // Both confirms land in one microtask batch — no re-render between
    // them, so a stale-prop commit would drop the first entry.
    await act(async () => {
      gates[0]!(confirmResponse('u-a', 'a.pdf'));
      gates[1]!(confirmResponse('u-b', 'b.pdf'));
    });
    await waitFor(() => expect(screen.getByText('b.pdf')).toBeInTheDocument());
    expect(screen.getByText('a.pdf')).toBeInTheDocument();
    expect(screen.getAllByTitle('Remove')).toHaveLength(2);
  });
});

describe('room check (shared FILE_MULTI_CAP)', () => {
  it('one slot left truncates the batch to it and shows the cap message', async () => {
    const committed = Array.from({ length: FILE_MULTI_CAP - 1 }, (_, i) =>
      oldEntry(`u-${i}`, `f-${i}.pdf`),
    );
    renderForm({ multiple: true }, { files: committed });
    await act(async () => {
      pickFiles([pdf('fits.pdf'), pdf('overflow.pdf')]);
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      `This field holds at most ${FILE_MULTI_CAP} files.`,
    );
    await waitFor(() => expect(uploadFile).toHaveBeenCalledTimes(1));
    expect((uploadFile.mock.calls[0]![0] as { file: File }).file.name).toBe('fits.pdf');
  });

  it('at the cap nothing uploads', async () => {
    const committed = Array.from({ length: FILE_MULTI_CAP }, (_, i) =>
      oldEntry(`u-${i}`, `f-${i}.pdf`),
    );
    renderForm({ multiple: true }, { files: committed });
    await act(async () => {
      pickFiles([pdf('nope.pdf')]);
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      `This field holds at most ${FILE_MULTI_CAP} files.`,
    );
    expect(uploadFile).not.toHaveBeenCalled();
  });
});

describe('upload lifecycle', () => {
  it('uploads with {type:"asset"} and NO id, even in edit mode with an assetId', async () => {
    renderForm({}); // mode="edit", assetId="a-1" — the id must still not ride along
    await act(async () => {
      pickFiles([pdf('new.pdf')]);
    });
    await waitFor(() => expect(uploadFile).toHaveBeenCalledTimes(1));
    const call = uploadFile.mock.calls[0]![0] as {
      attachTo: { type: string };
      signal: AbortSignal;
    };
    expect(call.attachTo).toEqual({ type: 'asset' });
    expect(call.attachTo).not.toHaveProperty('id');
    expect(call.signal).toBeInstanceOf(AbortSignal);
  });

  it('gates Save while an upload is pending and releases it on confirm', async () => {
    let resolveUpload: (v: unknown) => void = () => {};
    uploadFile.mockImplementation(
      () => new Promise((resolve) => (resolveUpload = resolve)),
    );
    renderForm({});
    expect(saveButton()).toBeEnabled();

    await act(async () => {
      pickFiles([pdf('new.pdf')]);
    });
    expect(saveButton()).toBeDisabled();

    await act(async () => {
      resolveUpload(confirmResponse('u-new', 'new.pdf'));
    });
    await waitFor(() => expect(saveButton()).toBeEnabled());
  });

  it('a failed upload keeps its row with Retry/Dismiss, releases the gate, and Retry re-uploads the same file', async () => {
    uploadFile.mockRejectedValueOnce(new Error('boom'));
    renderForm({});
    await act(async () => {
      pickFiles([pdf('flaky.pdf')]);
    });

    expect(await screen.findByRole('alert')).toHaveTextContent('flaky.pdf');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Dismiss failed upload of flaky.pdf' }),
    ).toBeInTheDocument();
    // Failed rows do not hold the Save gate.
    await waitFor(() => expect(saveButton()).toBeEnabled());
    expect(screen.queryByTitle('Remove')).not.toBeInTheDocument(); // nothing committed

    uploadFile.mockResolvedValueOnce(confirmResponse('u-retried', 'flaky.pdf'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    });
    await waitFor(() => expect(screen.getAllByTitle('Remove')).toHaveLength(1));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect((uploadFile.mock.calls[1]![0] as { file: File }).file.name).toBe('flaky.pdf');
  });

  it('Retry is disabled and inert while the asset is saving', async () => {
    // Once Save is in flight the payload is captured — a retried upload
    // could confirm after navigation and become an unattached orphan
    // that looks saved.
    uploadFile.mockRejectedValueOnce(new Error('boom'));
    renderForm({});
    await act(async () => {
      pickFiles([pdf('flaky.pdf')]);
    });
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeEnabled();

    // Failed rows released the gate, so Save is clickable; apiFetch
    // hangs, so `saving` stays true.
    await act(async () => {
      fireEvent.click(saveButton());
    });
    const retry = screen.getByRole('button', { name: 'Retry' });
    expect(retry).toBeDisabled();
    fireEvent.click(retry);
    expect(uploadFile).toHaveBeenCalledTimes(1); // no new upload started
  });
});

describe('per-field constraints', () => {
  it('rejects a file violating options.accept before any upload, with the joined attr on the input', async () => {
    renderForm({ accept: ['application/pdf'] });
    expect(fileInput()).toHaveAttribute('accept', 'application/pdf');

    await act(async () => {
      pickFiles([new File([new Uint8Array(4)], 'photo.png', { type: 'image/png' })]);
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      '“photo.png” isn’t an accepted type for this field.',
    );
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it('rejects oversize files via preflight with the field maxSizeMb', async () => {
    renderForm({ maxSizeMb: 0.000001 }); // ~1 byte
    await act(async () => {
      pickFiles([pdf('big.pdf', 64)]);
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('exceeds');
    expect(uploadFile).not.toHaveBeenCalled();
  });
});
