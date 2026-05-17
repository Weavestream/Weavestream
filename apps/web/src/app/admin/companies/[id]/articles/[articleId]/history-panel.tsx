'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch } from '../../../../../../lib/api';
import {
  Btn,
  Dialog,
  Icon,
  Sheet,
  Tag,
  useToast,
} from '../../../../../../components/ui';
import { ArticleBody } from '../../../../../../components/editor/article-body';
import type {
  ArticleVersionDetail,
  ArticleVersionSummary,
} from '../../../../../../lib/server-api';

/**
 * Right-side drawer surfacing the article's published version
 * history. Each row shows the version number, author, timestamp, and
 * any changed-field chips; clicking "View" loads the full snapshot in
 * a preview drawer; clicking "Restore" replays that snapshot through
 * `update()` to produce a new published row (forward-only history).
 *
 * Read-only mode kicks in when the article is archived or the user
 * lacks write access — the Restore button is hidden and a tooltip
 * explains why. The "Draft in progress" badge only renders when the
 * caller passes `hasDraft=true` (drafts are dropped on archive, so
 * this combination is impossible for archived articles).
 */
export function HistoryPanel({
  open,
  onClose,
  companyId,
  articleId,
  hasDraft,
  canRestore,
}: {
  open: boolean;
  onClose: () => void;
  companyId: string;
  articleId: string;
  hasDraft: boolean;
  canRestore: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [versions, setVersions] = useState<ArticleVersionSummary[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [previewing, setPreviewing] = useState<number | null>(null);
  const [preview, setPreview] = useState<ArticleVersionDetail | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [confirmRestore, setConfirmRestore] = useState<number | null>(null);
  const [restoring, setRestoring] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await apiFetch<ArticleVersionSummary[]>(
      `/companies/${companyId}/articles/${articleId}/versions`,
    );
    setLoading(false);
    if (!res.ok || !res.data) {
      toast.push('Could not load version history.', 'danger');
      return;
    }
    setVersions(res.data);
  }, [articleId, companyId, toast]);

  useEffect(() => {
    if (!open) return;
    setPreviewing(null);
    setPreview(null);
    setConfirmRestore(null);
    void load();
  }, [open, load]);

  async function openPreview(version: number) {
    setPreviewing(version);
    setPreviewLoading(true);
    setPreview(null);
    const res = await apiFetch<ArticleVersionDetail>(
      `/companies/${companyId}/articles/${articleId}/versions/${version}`,
    );
    setPreviewLoading(false);
    if (!res.ok || !res.data) {
      toast.push('Could not load version preview.', 'danger');
      setPreviewing(null);
      return;
    }
    setPreview(res.data);
  }

  async function performRestore() {
    if (confirmRestore === null) return;
    setRestoring(true);
    const res = await apiFetch(
      `/companies/${companyId}/articles/${articleId}/versions/${confirmRestore}/restore`,
      { method: 'POST' },
    );
    setRestoring(false);
    if (!res.ok) {
      toast.push('Restore failed.', 'danger');
      return;
    }
    const restoredVersion = confirmRestore;
    setConfirmRestore(null);
    setPreviewing(null);
    setPreview(null);
    toast.push(`Restored from version ${restoredVersion}.`, 'ok');
    onClose();
    router.refresh();
  }

  return (
    <>
      <Sheet open={open} onClose={onClose} side="right" width={420} ariaLabel="Version history">
        <header
          style={{
            padding: '14px 18px',
            borderBottom: '1px solid var(--line)',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <h2
            style={{
              margin: 0,
              fontFamily: 'var(--font-display)',
              fontSize: 15,
              fontWeight: 600,
            }}
          >
            Version history
          </h2>
          {hasDraft && <Tag tone="warn">draft in progress</Tag>}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              marginLeft: 'auto',
              width: 28,
              height: 28,
              border: '1px solid var(--line-2)',
              background: 'var(--panel-2)',
              borderRadius: 5,
              color: 'var(--muted)',
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Icon.x size={14} />
          </button>
        </header>

        <div style={{ overflow: 'auto', padding: '12px 8px', flex: 1 }}>
          {loading && (
            <p style={{ color: 'var(--muted)', fontSize: 13, padding: 12 }}>
              Loading…
            </p>
          )}
          {!loading && versions && versions.length === 0 && (
            <p style={{ color: 'var(--muted)', fontSize: 13, padding: 12 }}>
              No published versions yet.
            </p>
          )}
          {!loading && versions && versions.length > 0 && (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {versions.map((v, idx) => {
                const isCurrent = idx === 0;
                return (
                  <li
                    key={v.version}
                    style={{
                      padding: '10px 10px',
                      borderRadius: 6,
                      marginBottom: 4,
                      background: isCurrent ? 'var(--panel-2)' : 'transparent',
                      border: '1px solid',
                      borderColor: isCurrent ? 'var(--line-2)' : 'transparent',
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        marginBottom: 4,
                      }}
                    >
                      <strong
                        style={{
                          fontSize: 13,
                          fontFamily: 'var(--font-mono)',
                          color: 'var(--text)',
                        }}
                      >
                        v{v.version}
                      </strong>
                      {isCurrent && <Tag tone="ok">current</Tag>}
                      {v.changeReason && (
                        <Tag tone="outline">{v.changeReason}</Tag>
                      )}
                    </div>
                    <div
                      style={{
                        fontSize: 12,
                        color: 'var(--muted)',
                        marginBottom: 6,
                      }}
                    >
                      {v.changedByName ?? 'Unknown'} ·{' '}
                      {new Date(v.updatedAt).toLocaleString()}
                    </div>
                    {v.changedFields.length > 0 && (
                      <div
                        style={{
                          display: 'flex',
                          gap: 4,
                          flexWrap: 'wrap',
                          marginBottom: 8,
                        }}
                      >
                        {v.changedFields.map((f) => (
                          <Tag key={f} tone="outline">
                            {f}
                          </Tag>
                        ))}
                      </div>
                    )}
                    <div style={{ display: 'flex', gap: 6 }}>
                      <Btn
                        size="md"
                        kind="ghost"
                        onClick={() => openPreview(v.version)}
                      >
                        View
                      </Btn>
                      <Btn
                        size="md"
                        kind="outline"
                        disabled={!canRestore || isCurrent}
                        title={
                          !canRestore
                            ? 'Restore the article first.'
                            : isCurrent
                              ? 'Already the current version.'
                              : undefined
                        }
                        onClick={() => setConfirmRestore(v.version)}
                      >
                        Restore
                      </Btn>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </Sheet>

      <Sheet
        open={previewing !== null}
        onClose={() => {
          setPreviewing(null);
          setPreview(null);
        }}
        side="right"
        width={720}
        ariaLabel="Version preview"
      >
        <header
          style={{
            padding: '14px 18px',
            borderBottom: '1px solid var(--line)',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <h2
            style={{
              margin: 0,
              fontFamily: 'var(--font-display)',
              fontSize: 15,
              fontWeight: 600,
            }}
          >
            v{previewing} preview
          </h2>
          {preview && (
            <span style={{ color: 'var(--muted)', fontSize: 12 }}>
              {preview.changedByName ?? 'Unknown'} ·{' '}
              {new Date(preview.updatedAt).toLocaleString()}
            </span>
          )}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            {canRestore && previewing !== null && (
              <Btn
                size="md"
                kind="outline"
                onClick={() => setConfirmRestore(previewing)}
              >
                Restore this version
              </Btn>
            )}
            <button
              type="button"
              onClick={() => {
                setPreviewing(null);
                setPreview(null);
              }}
              aria-label="Close"
              style={{
                width: 28,
                height: 28,
                border: '1px solid var(--line-2)',
                background: 'var(--panel-2)',
                borderRadius: 5,
                color: 'var(--muted)',
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Icon.x size={14} />
            </button>
          </div>
        </header>
        <div style={{ overflow: 'auto', padding: '24px 28px', flex: 1 }}>
          {previewLoading && (
            <p style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</p>
          )}
          {!previewLoading && preview && (
            <article style={{ maxWidth: 800, margin: '0 auto' }}>
              <h1
                style={{
                  fontFamily: 'var(--font-display)',
                  fontSize: 28,
                  fontWeight: 600,
                  margin: '0 0 16px',
                  lineHeight: 1.15,
                }}
              >
                {preview.title}
              </h1>
              <ArticleBody
                editorMode={preview.editorMode}
                content={preview.content}
                markdownSource={preview.markdownSource}
              />
            </article>
          )}
        </div>
      </Sheet>

      <Dialog
        open={confirmRestore !== null}
        onClose={() => {
          if (!restoring) setConfirmRestore(null);
        }}
        title="Restore this version?"
        width={460}
        footer={
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Btn
              kind="outline"
              onClick={() => setConfirmRestore(null)}
              disabled={restoring}
            >
              Cancel
            </Btn>
            <Btn kind="primary" onClick={performRestore} loading={restoring}>
              Restore
            </Btn>
          </div>
        }
      >
        <p style={{ margin: 0, lineHeight: 1.5, color: 'var(--text)' }}>
          {hasDraft
            ? 'Any in-progress autosave draft will be discarded, then version '
            : 'Version '}
          <strong>v{confirmRestore}</strong> will be re-applied to the
          article as a new published version. The current content stays
          in history at its existing version number.
        </p>
      </Dialog>
    </>
  );
}
