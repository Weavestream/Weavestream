'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import {
  parseMarkdownImport,
  problemMessage,
  suffixedArticleIdentity,
} from '@weavestream/shared';
import { apiFetch } from '../../../../../lib/api';
import { Btn, Checkbox, Dialog, Icon, Tag, useToast } from '../../../../../components/ui';
import type { TagTone } from '../../../../../components/ui/tag';

/** Files per import. Keeps a batch far below the per-user rate limit. */
export const MAX_IMPORT_FILES = 100;
/** The API's JSON body limit; checked before a file is read. */
export const MAX_IMPORT_FILE_BYTES = 2 * 1024 * 1024;
/** Highest `n` tried for ` n` / `-n` after a slug conflict. */
const MAX_SUFFIX = 20;

type ItemStatus =
  | 'ready'
  | 'rejected'
  | 'pending'
  | 'created'
  | 'failed'
  | 'uncertain'
  | 'skipped';

type ImportItem = {
  key: string;
  fileName: string;
  title: string;
  markdownSource: string;
  status: ItemStatus;
  reason?: string;
};

type Phase = 'closed' | 'review' | 'running' | 'done';

const STATUS_LABEL: Record<ItemStatus, { label: string; tone: TagTone }> = {
  ready: { label: 'ready', tone: 'outline' },
  rejected: { label: 'cannot import', tone: 'danger' },
  pending: { label: 'importing', tone: 'info' },
  created: { label: 'imported', tone: 'ok' },
  failed: { label: 'failed', tone: 'danger' },
  uncertain: { label: 'uncertain', tone: 'warn' },
  skipped: { label: 'not imported', tone: 'default' },
};

const UNCERTAIN_REASON =
  'Connection lost. This article may have been created. Check the list before you import it again.';

/**
 * Read the RFC 7807 `error` discriminator from an `apiFetch` problem.
 * `problem` is `unknown` because the server shape isn't guaranteed on
 * every status code. Also used by the folder create flow.
 */
export function isSlugTaken(problem: unknown): boolean {
  if (!problem || typeof problem !== 'object') return false;
  return (problem as { error?: unknown }).error === 'SlugTaken';
}

/**
 * Import one or more `.md` files as articles in the selected folder.
 * Each file is one call to the normal create endpoint, so permission,
 * folder, slug, and audit checks run per article on the server.
 */
export function ArticleImportButton({
  companyId,
  folderId,
  folderName,
}: {
  companyId: string;
  /** A real folder id, or null for "All" / "No folder". */
  folderId: string | null;
  folderName: string | null;
}) {
  const router = useRouter();
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const runningRef = useRef(false);
  const [phase, setPhase] = useState<Phase>('closed');
  const [items, setItems] = useState<ImportItem[]>([]);
  const [visibleToClients, setVisibleToClients] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });

  const running = phase === 'running';

  // Warn before a reload or tab close while writes are still in flight.
  useEffect(() => {
    if (!running) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [running]);

  function close() {
    // Escape, backdrop, and Cancel all land here: ignore them mid-run so
    // the progress and the final summary cannot be lost.
    if (runningRef.current) return;
    setPhase('closed');
    setItems([]);
  }

  async function onPick(list: FileList | null) {
    const files = Array.from(list ?? []);
    // Reset so the same file can be picked again later.
    if (inputRef.current) inputRef.current.value = '';
    if (files.length === 0 || runningRef.current) return;
    const next = await Promise.all(files.map((f, i) => prepareFile(f, i)));
    setVisibleToClients(false);
    setItems(next);
    setProgress({ done: 0, total: 0 });
    setPhase('review');
  }

  async function importOne(
    item: ImportItem,
  ): Promise<{ status: ItemStatus; reason?: string; stop?: boolean }> {
    for (let n = 1; n <= MAX_SUFFIX; n++) {
      const identity =
        n === 1 ? { title: item.title } : suffixedArticleIdentity(item.title, n);
      let res: Awaited<ReturnType<typeof apiFetch<{ id: string }>>>;
      try {
        res = await apiFetch<{ id: string }>(`/companies/${companyId}/articles`, {
          method: 'POST',
          body: JSON.stringify({
            ...identity,
            ...(folderId ? { folderId } : {}),
            visibleToClients,
            editorMode: 'markdown',
            markdownSource: item.markdownSource,
          }),
        });
      } catch {
        // The request may have reached the server before the connection
        // dropped, so the outcome is unknown, not failed.
        return { status: 'uncertain', reason: UNCERTAIN_REASON, stop: true };
      }
      if (res.ok) {
        return n === 1
          ? { status: 'created' }
          : { status: 'created', reason: `Imported as “${identity.title}”` };
      }
      if (res.status === 409 && isSlugTaken(res.problem)) continue;
      const reason =
        problemMessage(res.problem) ?? `Import failed (HTTP ${res.status || 'error'})`;
      if (res.status === 401 || res.status === 429) {
        return { status: 'failed', reason, stop: true };
      }
      return { status: 'failed', reason };
    }
    return { status: 'failed', reason: 'Too many articles already use this title.' };
  }

  async function runImport() {
    if (runningRef.current) return;
    const results = items.map((i) => ({ ...i }));
    const queue = results.filter((r) => r.status === 'ready');
    if (queue.length === 0) return;
    runningRef.current = true;
    setPhase('running');
    setProgress({ done: 0, total: queue.length });
    let wrote = false;
    try {
      for (let qi = 0; qi < queue.length; qi++) {
        const item = queue[qi]!;
        item.status = 'pending';
        setItems(results.map((r) => ({ ...r })));
        const out = await importOne(item);
        item.status = out.status;
        item.reason = out.reason;
        if (out.status === 'created' || out.status === 'uncertain') wrote = true;
        setProgress({ done: qi + 1, total: queue.length });
        if (out.stop) {
          for (const rest of queue.slice(qi + 1)) {
            rest.status = 'skipped';
            rest.reason = 'Not imported because the import stopped.';
          }
          break;
        }
      }
    } catch {
      // Defensive: `importOne` catches request errors itself. Anything
      // else leaves unfinished files marked rather than stuck "importing".
      for (const r of queue) {
        if (r.status === 'pending') {
          r.status = 'uncertain';
          r.reason = UNCERTAIN_REASON;
          wrote = true;
        } else if (r.status === 'ready') {
          r.status = 'skipped';
          r.reason = 'Not imported because the import stopped.';
        }
      }
    } finally {
      runningRef.current = false;
      setItems(results.map((r) => ({ ...r })));
      setPhase('done');
      if (wrote) router.refresh();
    }

    const created = queue.filter((r) => r.status === 'created').length;
    if (created === queue.length && results.length === queue.length) {
      toast.push(`Imported ${created} article${created === 1 ? '' : 's'}`, 'ok');
      setPhase('closed');
      setItems([]);
    }
  }

  const readyCount = items.filter((i) => i.status === 'ready').length;
  const count = (s: ItemStatus) => items.filter((i) => i.status === s).length;

  const footer =
    phase === 'done' ? (
      <Btn kind="primary" onClick={close}>
        Close
      </Btn>
    ) : (
      <>
        <Btn kind="ghost" onClick={close} disabled={running}>
          Cancel
        </Btn>
        <Btn
          kind="primary"
          onClick={() => void runImport()}
          disabled={running || readyCount === 0}
          loading={running}
        >
          {running
            ? `Importing ${Math.min(progress.done + 1, progress.total)} of ${progress.total}…`
            : `Import ${readyCount} article${readyCount === 1 ? '' : 's'}`}
        </Btn>
      </>
    );

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept=".md,.markdown,text/markdown"
        hidden
        data-testid="article-import-input"
        disabled={phase !== 'closed'}
        onChange={(e) => void onPick(e.target.files)}
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={phase !== 'closed'}
        title="Import Markdown files as articles"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          height: 28,
          padding: '0 10px',
          background: 'transparent',
          border: '1px solid var(--line-2)',
          borderRadius: 5,
          fontSize: 12,
          color: 'var(--text-2)',
          cursor: phase === 'closed' ? 'pointer' : 'default',
        }}
      >
        <Icon.upload size={12} />
        Import
      </button>
      <Dialog
        open={phase !== 'closed'}
        onClose={close}
        title="Import Markdown files"
        width={560}
        footer={footer}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, fontSize: 12.5 }}>
          <div style={{ color: 'var(--text-2)' }}>
            {items.length} file{items.length === 1 ? '' : 's'} ·{' '}
            {folderName ? (
              <>
                Into folder: <strong>{folderName}</strong>
              </>
            ) : (
              'Into: No folder'
            )}
          </div>
          {phase === 'done' && (
            <div role="status" style={{ color: 'var(--text)' }}>
              {count('created')} imported, {count('failed') + count('rejected')} failed,{' '}
              {count('skipped')} not imported, {count('uncertain')} uncertain
            </div>
          )}
          <ul
            style={{
              listStyle: 'none',
              margin: 0,
              padding: 0,
              border: '1px solid var(--line)',
              borderRadius: 5,
              maxHeight: 300,
              overflowY: 'auto',
            }}
          >
            {items
              .filter((i) => phase !== 'done' || i.status !== 'created' || i.reason)
              .map((i) => (
                <li
                  key={i.key}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 8,
                    padding: '7px 10px',
                    borderBottom: '1px solid var(--line)',
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        color: 'var(--text)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {i.title || i.fileName}
                    </div>
                    <div style={{ color: 'var(--muted)', fontSize: 11.5, wordBreak: 'break-word' }}>
                      {i.fileName}
                      {i.reason ? ` — ${i.reason}` : ''}
                    </div>
                  </div>
                  <Tag tone={STATUS_LABEL[i.status].tone}>{STATUS_LABEL[i.status].label}</Tag>
                </li>
              ))}
          </ul>
          <Checkbox
            label="Visible to clients"
            hint="Applies to every article in this import."
            checked={visibleToClients}
            onChange={setVisibleToClients}
            disabled={phase !== 'review'}
          />
        </div>
      </Dialog>
    </>
  );
}

async function prepareFile(file: File, index: number): Promise<ImportItem> {
  const base = { key: `${index}:${file.name}`, fileName: file.name, title: '', markdownSource: '' };
  if (index >= MAX_IMPORT_FILES) {
    return { ...base, status: 'rejected', reason: `Only ${MAX_IMPORT_FILES} files per import.` };
  }
  if (!/\.(md|markdown)$/i.test(file.name)) {
    return { ...base, status: 'rejected', reason: 'Not a .md file.' };
  }
  if (file.size > MAX_IMPORT_FILE_BYTES) {
    return { ...base, status: 'rejected', reason: 'File is larger than 2 MB.' };
  }
  let text: string;
  try {
    text = await readText(file);
  } catch {
    return { ...base, status: 'rejected', reason: 'Could not read the file.' };
  }
  const parsed = parseMarkdownImport(text, file.name);
  if (!parsed.ok) return { ...base, status: 'rejected', reason: parsed.reason };
  return { ...base, title: parsed.title, markdownSource: parsed.markdownSource, status: 'ready' };
}

/** `File.text()`, with a `FileReader` fallback for older engines (jsdom). */
function readText(file: File): Promise<string> {
  if (typeof file.text === 'function') return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsText(file);
  });
}
