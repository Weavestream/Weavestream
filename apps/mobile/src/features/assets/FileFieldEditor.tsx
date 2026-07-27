import { useEffect, useRef, useState } from 'react';
import { describeUploadError, preflightFile } from '@weavestream/shared/browser';
import { Icon } from '../../components/Icon';
import { Hint } from '../../components/FieldBlock';
import { Button } from '../../components/primitives';
import { uploadFile } from '../../lib/upload';
import type { LayoutFieldRecord } from './api';
import { fieldAcceptsImages, matchesAccept } from './accept-match';
import { FileTile, FileTileGrid } from './FileTileGrid';
import type { FieldEditorValue, FileEntryDraft } from './field-values';

/**
 * FILE field editor: immediate upload on selection, tiles with
 * progress/cancel/retry, and TWO pick affordances resolving the
 * build-plan requirement (mobile-pwa-build-plan.md — camera capture is
 * the point of FILE-on-mobile) against fields that don't accept images:
 *
 *  - "Take photo": `accept="image/*" capture="environment"` — straight
 *    to the rear camera for serial plates / wiring closets. Rendered
 *    only when `fieldAcceptsImages(options.accept)`.
 *  - "Choose file": `accept={options.accept.join(',')}`, no `capture`,
 *    so the OS chooser still offers library/files.
 *
 * HTML `accept` is only a chooser hint, so every selected file — from
 * either input — is validated with the same `matchesAccept` matcher
 * before `preflightFile`'s global size/mime gate ever runs.
 *
 * `multiple` mirrors the SERVER (`options.multiple === true`): the
 * strategy caps at 1 unless the option is explicitly true, and
 * desktop's `?? true` default is a known bug that lets it attempt
 * uploads the API then rejects. Single mode replaces the entry.
 *
 * Uploads are confirmed with `{type:'asset'}` and NO id (create AND
 * edit) — `linkFileFieldUploadsToAsset` attaches inside the successful
 * asset-write transaction, so a cancelled form leaves no ghost
 * attachment. In-flight uploads gate Save via `onPendingChange`.
 */

const MULTI_CAP = 100;

interface PendingUpload {
  key: string;
  file: File;
  percent: number;
  controller: AbortController;
  /** Non-null = failed (retry/dismiss); null = uploading. */
  error: string | null;
}

export function FileFieldEditor({
  field,
  id,
  companyId,
  value,
  onChange,
  onPendingChange,
  disabled,
}: {
  field: LayoutFieldRecord;
  /** FieldBlock label target — lands on the always-rendered chooser button. */
  id: string;
  companyId: string | null;
  value: Extract<FieldEditorValue, { kind: 'file' }>;
  onChange: (next: FieldEditorValue) => void;
  onPendingChange: (inFlight: number) => void;
  disabled?: boolean;
}) {
  const [pending, setPending] = useState<PendingUpload[]>([]);
  const [rejected, setRejected] = useState<string | null>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const counter = useRef(0);
  // The committed array lives in form state, which async confirms close
  // over. This ref tracks the LATEST committed value: renders sync it
  // from props (user removals included), and confirms update it
  // synchronously before calling onChange — see the commit comment in
  // startUpload for the same-tick double-confirm race it prevents.
  const committedRef = useRef(value);
  committedRef.current = value;
  // Every in-flight upload's abort controller, so single-file mode can
  // supersede older uploads the moment a new pick starts.
  const inFlightControllers = useRef(new Set<AbortController>());

  const multiple = field.options['multiple'] === true;
  const accept = Array.isArray(field.options['accept'])
    ? (field.options['accept'] as unknown[]).filter(
        (t): t is string => typeof t === 'string',
      )
    : undefined;
  const maxBytes =
    (typeof field.options['maxSizeMb'] === 'number'
      ? (field.options['maxSizeMb'] as number)
      : 25) *
    1024 *
    1024;

  const inFlight = pending.filter((p) => p.error === null).length;
  useEffect(() => {
    onPendingChange(inFlight);
  }, [inFlight, onPendingChange]);
  // Unmount must release the Save gate. Cleanup-only effect: the
  // callback identity is stable (useCallback in the form hook), and
  // running it once on unmount is exactly the contract.
  useEffect(() => () => onPendingChange(0), [onPendingChange]);

  function startUpload(file: File) {
    if (companyId === null) return;

    // Single-file mode: a new pick SUPERSEDES anything still uploading.
    // Without this, a slower earlier upload that finishes last would
    // overwrite the newer selection (its confirm replaces the array).
    // Aborting first means at most one upload can ever commit.
    if (!multiple) {
      for (const controller of inFlightControllers.current) controller.abort();
    }

    const key = `${file.name}:${file.size}:${counter.current++}`;
    const controller = new AbortController();
    inFlightControllers.current.add(controller);
    setPending((prev) => [
      ...prev,
      { key, file, percent: 0, controller, error: null },
    ]);

    uploadFile({
      companyId,
      file,
      // Type only, never an id — see the module comment.
      attachTo: { type: 'asset' },
      signal: controller.signal,
      onProgress: (p) =>
        setPending((prev) =>
          prev.map((entry) =>
            entry.key === key ? { ...entry, percent: p.percent } : entry,
          ),
        ),
    })
      .then((res) => {
        const draft: FileEntryDraft = {
          entry: {
            uploadId: res.id,
            filename: res.filename,
            mimeType: res.mimeType,
            sizeBytes: res.sizeBytes,
            isImage: res.isImage,
          },
          thumbnailUrl: res.thumbnailUrl,
          downloadUrl: res.downloadUrl,
        };
        // Commit through the synchronous ref, not the render-time prop:
        // two confirms landing in the same tick each see the other's
        // append instead of a stale snapshot (React hasn't re-rendered
        // between their microtasks).
        const next: typeof value = {
          kind: 'file',
          entries: multiple ? [...committedRef.current.entries, draft] : [draft],
        };
        committedRef.current = next;
        onChange(next);
        setPending((prev) => prev.filter((entry) => entry.key !== key));
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) {
          // Cancelled or superseded — remove silently.
          setPending((prev) => prev.filter((entry) => entry.key !== key));
          return;
        }
        setPending((prev) =>
          prev.map((entry) =>
            entry.key === key
              ? { ...entry, error: describeUploadError(err, file.name) }
              : entry,
          ),
        );
      })
      .finally(() => {
        inFlightControllers.current.delete(controller);
      });
  }

  function onFilesPicked(list: FileList | null) {
    setRejected(null);
    if (!list || list.length === 0) return;
    const files = multiple ? Array.from(list) : [list[0]!];

    if (multiple) {
      const room = MULTI_CAP - value.entries.length - pending.length;
      if (files.length > room) {
        setRejected(`This field holds at most ${MULTI_CAP} files.`);
        files.length = Math.max(0, room);
      }
    }

    for (const file of files) {
      // The per-field accept gate first — HTML accept is only a hint.
      if (!matchesAccept(file, accept)) {
        setRejected(`“${file.name}” isn’t an accepted type for this field.`);
        continue;
      }
      const problem = preflightFile(file, { maxBytes });
      if (problem !== null) {
        setRejected(problem);
        continue;
      }
      startUpload(file);
    }
  }

  function removeCommitted(uploadId: string) {
    onChange({
      kind: 'file',
      entries: value.entries.filter((d) => d.entry.uploadId !== uploadId),
    });
  }

  const showCamera = fieldAcceptsImages(accept);
  const hasTiles = value.entries.length > 0 || pending.length > 0;

  return (
    <div className="flex flex-col gap-2.5">
      {hasTiles && (
        <FileTileGrid>
          {value.entries.map((draft) => (
            <FileTile
              key={draft.entry.uploadId}
              filename={draft.entry.filename}
              sizeBytes={draft.entry.sizeBytes}
              isImage={
                draft.entry.isImage ?? draft.entry.mimeType.startsWith('image/')
              }
              thumbnailUrl={draft.thumbnailUrl}
              href={draft.downloadUrl}
              action={
                <button
                  type="button"
                  aria-label={`Remove ${draft.entry.filename}`}
                  disabled={disabled}
                  onClick={() => removeCommitted(draft.entry.uploadId)}
                  className={
                    'absolute -right-1.75 -top-1.75 flex h-7 w-7 min-h-0 min-w-0 items-center ' +
                    'justify-center rounded-pill bg-text text-surface shadow-sm'
                  }
                  style={{ minHeight: 28, minWidth: 28 }}
                >
                  <Icon name="close" size={16} />
                </button>
              }
            />
          ))}

          {pending.map((entry) => (
            <FileTile
              key={entry.key}
              filename={entry.file.name}
              sizeBytes={entry.file.size}
              isImage={entry.file.type.startsWith('image/')}
              thumbnailUrl={null}
              href={null}
              overlay={
                entry.error === null ? (
                  <span className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-surface/80">
                    <span className="text-[13px] font-semibold text-text">
                      {entry.percent}%
                    </span>
                    <button
                      type="button"
                      aria-label={`Cancel upload of ${entry.file.name}`}
                      onClick={() => entry.controller.abort()}
                      className="text-[13px] font-medium text-accent-text"
                    >
                      Cancel
                    </button>
                  </span>
                ) : (
                  <span className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-danger-soft px-1.75 text-center">
                    <Icon name="error" size={18} className="text-danger" />
                    <span className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          const file = entry.file;
                          setPending((prev) => prev.filter((p) => p.key !== entry.key));
                          startUpload(file);
                        }}
                        className="text-[13px] font-medium text-accent-text"
                      >
                        Retry
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          setPending((prev) => prev.filter((p) => p.key !== entry.key))
                        }
                        className="text-[13px] font-medium text-muted"
                      >
                        Dismiss
                      </button>
                    </span>
                  </span>
                )
              }
            />
          ))}
        </FileTileGrid>
      )}

      {pending.some((p) => p.error !== null) && (
        <p role="alert" className="text-[13px] leading-snug text-danger">
          {pending.find((p) => p.error !== null)!.error}
        </p>
      )}
      {rejected && (
        <p role="alert" className="text-[13px] leading-snug text-danger">
          {rejected}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        {showCamera && (
          <Button
            kind="secondary"
            icon="photo_camera"
            disabled={disabled || companyId === null}
            onClick={() => cameraRef.current?.click()}
          >
            Take photo
          </Button>
        )}
        <Button
          id={id}
          kind="secondary"
          icon="photo_library"
          disabled={disabled || companyId === null}
          onClick={() => fileRef.current?.click()}
        >
          {multiple || value.entries.length === 0 ? 'Choose file' : 'Replace file'}
        </Button>
      </div>

      {/* Two hidden inputs — see the module comment for why. */}
      {showCamera && (
        <input
          ref={cameraRef}
          type="file"
          accept="image/*"
          capture="environment"
          multiple={multiple}
          className="hidden"
          aria-hidden
          tabIndex={-1}
          onChange={(e) => {
            onFilesPicked(e.target.files);
            e.target.value = '';
          }}
        />
      )}
      <input
        ref={fileRef}
        type="file"
        accept={accept && accept.length > 0 ? accept.join(',') : undefined}
        multiple={multiple}
        className="hidden"
        aria-hidden
        tabIndex={-1}
        onChange={(e) => {
          onFilesPicked(e.target.files);
          e.target.value = '';
        }}
      />

      {!multiple && value.entries.length > 0 && (
        <Hint>This field holds a single file — a new upload replaces it.</Hint>
      )}
    </div>
  );
}
