/**
 * @jest-environment jsdom
 */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FileFieldEditor } from './FileFieldEditor';
import { makeLayoutField } from './test-fixtures';
import type { FieldEditorValue, FileEntryDraft } from './field-values';

jest.mock('../../lib/upload', () => ({ uploadFile: jest.fn() }));
const { uploadFile } = jest.requireMock('../../lib/upload') as { uploadFile: jest.Mock };

const COMPANY = 'c0000000-0000-4000-8000-0000000000c1';

function field(options: Record<string, unknown> = {}) {
  return makeLayoutField({ slug: 'photos', name: 'Photos', fieldType: 'FILE', options });
}

function emptyValue(): Extract<FieldEditorValue, { kind: 'file' }> {
  return { kind: 'file', entries: [] };
}

function draft(uploadId: string, filename = 'rack.jpg'): FileEntryDraft {
  return {
    entry: { uploadId, filename, mimeType: 'image/jpeg', sizeBytes: 2048, isImage: true },
    thumbnailUrl: null,
    downloadUrl: `/dl/${uploadId}`,
  };
}

function confirmResponse(id: string, filename = 'rack.jpg') {
  return {
    id,
    companyId: COMPANY,
    filename,
    mimeType: 'image/jpeg',
    sizeBytes: 2048,
    isImage: true,
    width: null,
    height: null,
    thumbnailUrl: `/thumb/${id}`,
    downloadUrl: `/dl/${id}`,
    createdAt: '2026-07-26T10:00:00.000Z',
  };
}

function renderEditor(
  value = emptyValue(),
  options: Record<string, unknown> = {},
) {
  const onChange = jest.fn();
  const onPendingChange = jest.fn();
  const utils = render(
    <FileFieldEditor
      field={field(options)}
      id="af-photos"
      companyId={COMPANY}
      value={value}
      onChange={onChange}
      onPendingChange={onPendingChange}
    />,
  );
  return { onChange, onPendingChange, ...utils };
}

function pickFile(input: HTMLInputElement, file: File) {
  fireEvent.change(input, { target: { files: [file] } });
}

function hiddenInputs(): HTMLInputElement[] {
  return Array.from(document.querySelectorAll('input[type="file"]'));
}

beforeEach(() => {
  jest.clearAllMocks();
  uploadFile.mockResolvedValue(confirmResponse('u-new'));
});

describe('the two pick affordances', () => {
  it('camera input carries capture+image/*; file input carries the joined accept and no capture', () => {
    renderEditor(emptyValue(), { accept: ['image/jpeg', '.heic'] });
    const [camera, chooser] = hiddenInputs();
    expect(camera).toHaveAttribute('capture', 'environment');
    expect(camera).toHaveAttribute('accept', 'image/*');
    expect(chooser).toHaveAttribute('accept', 'image/jpeg,.heic');
    expect(chooser).not.toHaveAttribute('capture');
  });

  it('Take photo is hidden for a non-image accept (PDF-only) but shown for extension-form image accepts', () => {
    const { unmount } = renderEditor(emptyValue(), { accept: ['application/pdf'] });
    expect(screen.queryByRole('button', { name: 'Take photo' })).not.toBeInTheDocument();
    expect(hiddenInputs()).toHaveLength(1);
    unmount();

    renderEditor(emptyValue(), { accept: ['.jpg', '.heic'] });
    expect(screen.getByRole('button', { name: 'Take photo' })).toBeInTheDocument();
  });
});

describe('accept + preflight gating', () => {
  it('rejects a file violating options.accept client-side, before any upload call', async () => {
    renderEditor(emptyValue(), { accept: ['application/pdf'] });
    const [chooser] = hiddenInputs();
    await act(async () => {
      pickFile(chooser!, new File([new Uint8Array(4)], 'photo.png', { type: 'image/png' }));
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      '“photo.png” isn’t an accepted type for this field.',
    );
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it('rejects oversize files via preflight with the field maxSizeMb', async () => {
    renderEditor(emptyValue(), { maxSizeMb: 0.000001 }); // ~1 byte
    const [, chooser] = hiddenInputs();
    await act(async () => {
      pickFile(chooser!, new File([new Uint8Array(64)], 'big.png', { type: 'image/png' }));
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('exceeds');
    expect(uploadFile).not.toHaveBeenCalled();
  });
});

describe('upload lifecycle', () => {
  it('uploads with {type:asset} and NO id, appends the bare-entry draft, and gates Save while pending', async () => {
    let resolveUpload: (v: unknown) => void = () => {};
    uploadFile.mockImplementation(
      () => new Promise((resolve) => (resolveUpload = resolve)),
    );
    const { onChange, onPendingChange } = renderEditor(emptyValue(), { multiple: true });
    const [, chooser] = hiddenInputs();
    await act(async () => {
      pickFile(chooser!, new File([new Uint8Array(8)], 'rack.jpg', { type: 'image/jpeg' }));
    });

    expect(uploadFile).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: COMPANY, attachTo: { type: 'asset' } }),
    );
    expect(uploadFile.mock.calls[0]![0].attachTo).not.toHaveProperty('id');
    // Save gate raised while in flight.
    expect(onPendingChange).toHaveBeenLastCalledWith(1);

    await act(async () => {
      resolveUpload(confirmResponse('u-new'));
    });
    await waitFor(() => expect(onPendingChange).toHaveBeenLastCalledWith(0));
    expect(onChange).toHaveBeenCalledWith({
      kind: 'file',
      entries: [
        {
          entry: {
            uploadId: 'u-new',
            filename: 'rack.jpg',
            mimeType: 'image/jpeg',
            sizeBytes: 2048,
            isImage: true,
          },
          thumbnailUrl: '/thumb/u-new',
          downloadUrl: '/dl/u-new',
        },
      ],
    });
  });

  it('multiple === undefined behaves as SINGLE (server mirror, not desktop’s ?? true)', async () => {
    const { onChange } = renderEditor(
      { kind: 'file', entries: [draft('u-old', 'old.jpg')] },
      {}, // no multiple option at all
    );
    const inputs = hiddenInputs();
    for (const input of inputs) expect(input).not.toHaveAttribute('multiple');
    expect(screen.getByRole('button', { name: 'Replace file' })).toBeInTheDocument();

    const [, chooser] = inputs;
    await act(async () => {
      pickFile(chooser!, new File([new Uint8Array(8)], 'rack.jpg', { type: 'image/jpeg' }));
    });
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    // Replace semantics: the new confirm swaps the array.
    const next = onChange.mock.calls[0]![0] as { entries: FileEntryDraft[] };
    expect(next.entries).toHaveLength(1);
    expect(next.entries[0]!.entry.uploadId).toBe('u-new');
  });

  it('single mode: a new pick SUPERSEDES an in-flight upload — the older one aborts and never commits', async () => {
    const gates: Array<{
      resolve: (v: unknown) => void;
      signal: AbortSignal;
      name: string;
    }> = [];
    uploadFile.mockImplementation(
      (opts: { signal: AbortSignal; file: File }) =>
        new Promise((resolve, reject) => {
          gates.push({ resolve, signal: opts.signal, name: opts.file.name });
          opts.signal.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        }),
    );
    const { onChange } = renderEditor(emptyValue(), {}); // single mode
    const [, chooser] = hiddenInputs();

    await act(async () => {
      pickFile(chooser!, new File([new Uint8Array(8)], 'slow.jpg', { type: 'image/jpeg' }));
    });
    await act(async () => {
      pickFile(chooser!, new File([new Uint8Array(8)], 'newer.jpg', { type: 'image/jpeg' }));
    });

    // Starting the newer upload aborted the older one on the spot.
    expect(gates[0]!.signal.aborted).toBe(true);
    expect(gates[1]!.signal.aborted).toBe(false);

    // Even if the older promise resolved late, it could no longer
    // overwrite (it was rejected via abort); the newer one commits.
    await act(async () => {
      gates[1]!.resolve(confirmResponse('u-newer', 'newer.jpg'));
    });
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    const next = onChange.mock.calls[0]![0] as { entries: FileEntryDraft[] };
    expect(next.entries.map((d) => d.entry.uploadId)).toEqual(['u-newer']);
  });

  it('associates the FieldBlock label id with the always-rendered chooser button', () => {
    renderEditor(emptyValue(), { accept: ['application/pdf'] }); // camera hidden
    const target = document.getElementById('af-photos');
    expect(target).toBe(screen.getByRole('button', { name: 'Choose file' }));
  });

  it('failed uploads render an error with Retry, and removing a committed entry dirties the field', async () => {
    uploadFile.mockRejectedValueOnce(new Error('boom'));
    const { onChange } = renderEditor(
      { kind: 'file', entries: [draft('u-old', 'old.jpg')] },
      { multiple: true },
    );
    const [, chooser] = hiddenInputs();
    await act(async () => {
      pickFile(chooser!, new File([new Uint8Array(8)], 'rack.jpg', { type: 'image/jpeg' }));
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('rack.jpg');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Remove old.jpg' }));
    expect(onChange).toHaveBeenCalledWith({ kind: 'file', entries: [] });
  });
});
