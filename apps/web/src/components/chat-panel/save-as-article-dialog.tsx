'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { flattenFolderTree, splitMarkdownTitleAndBody } from '@weavestream/shared';
import type { ChatPendingCreate } from '@weavestream/shared';
import {
  Btn,
  CompanyPicker,
  Dialog,
  Field,
  Input,
  Select,
  useToast,
  type CompanyPickerValue,
} from '../ui';
import { apiFetch } from '../../lib/api';
import type { CompanyDetail, FolderNode } from '../../lib/server-api';

/**
 * Modal that turns a chat assistant response into a new article.
 *
 * Pre-fills the title from the first heading (or first line) of the
 * markdown body and pre-selects the company from the active chat page
 * context when one is available. Folders are loaded on demand once
 * the company is chosen so the picker shows the live tree.
 *
 * Submission hits the same `POST /companies/:id/articles` endpoint as
 * the regular new-article form, in Markdown editor mode — so the
 * server-side validation, audit log, and folder-uniqueness checks all
 * stay identical to a manually-created article.
 *
 * The same dialog is also reused as the confirmation step for chat
 * `create_article` tool calls: the caller passes `applyToolCall`,
 * which routes the submission through the chat apply endpoint with
 * the user-picked target instead of the regular `/articles` POST.
 * That avoids the LLM's hallucinated `folder_id` reaching the
 * articles service, while keeping the tool-call status bookkeeping
 * intact in the chat history.
 */
export type SaveAsArticleApplyHandler = (params: {
  companyId: string;
  title: string;
  folderId: string | null;
  visibleToClients: boolean;
}) => Promise<
  | { ok: true; articleId?: string }
  | { ok: false; error: string }
>;

export function SaveAsArticleDialog({
  open,
  markdown,
  defaultCompanyId,
  defaultTitle,
  defaultVisibleToClients,
  pendingCreate,
  applyToolCall,
  dialogTitle,
  submitLabel,
  onClose,
}: {
  open: boolean;
  markdown: string;
  defaultCompanyId: string | null;
  /**
   * Server-managed create-recovery marker (5b): a prior apply crashed
   * between creating the article and settling the tool call, so the
   * ORIGINAL confirmation is the only one the server will complete —
   * mismatched retries are rejected with
   * `ARTICLE_CREATE_RECOVERY_PENDING_CODE`. When present, every field
   * locks to the marker's values and submit sends them verbatim.
   */
  pendingCreate?: ChatPendingCreate;
  /**
   * Explicit title override. When set (e.g. the LLM-supplied
   * `args.title` on a `create_article` proposal), it wins over the
   * heading parsed from `markdown`. The user can still edit it before
   * submitting.
   */
  defaultTitle?: string;
  /**
   * Initial value for the "Visible to clients" checkbox. Defaults to
   * `false` to preserve the safer free-form save behavior. Tool-call
   * callers can opt in when the LLM proposed `visible_to_clients: true`.
   */
  defaultVisibleToClients?: boolean;
  /**
   * When provided, the dialog calls this handler on submit instead of
   * hitting `POST /companies/:id/articles` directly. Used by the chat
   * `create_article` Apply flow so the article creation goes through
   * the tool-call apply endpoint (which also flips the proposal to
   * the `applied` state in the chat history).
   */
  applyToolCall?: SaveAsArticleApplyHandler;
  /** Optional dialog header override (default: "Save as article"). */
  dialogTitle?: string;
  /** Optional submit-button label override (default: "Create article"). */
  submitLabel?: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  // Split out a leading top-level heading the LLM almost always emits.
  // The heading becomes the suggested title and is dropped from the body
  // so the article view doesn't render the same title twice. Shared
  // with the server-side `update_article` / `create_article` apply
  // path so the two ingestion routes stay consistent.
  const parsed = useMemo(() => splitMarkdownTitleAndBody(markdown), [markdown]);
  // Recovery lock: the marker's values are canonical — nothing else can
  // complete the crashed apply.
  const locked = pendingCreate !== undefined;
  const initialTitle = pendingCreate?.title ?? (defaultTitle?.trim() || parsed.title);
  const [title, setTitle] = useState(initialTitle);
  const [company, setCompany] = useState<CompanyPickerValue | null>(null);
  const [folders, setFolders] = useState<FolderNode[]>([]);
  const [folderId, setFolderId] = useState<string | null>(pendingCreate?.folderId ?? null);
  const [visibleToClients, setVisibleToClients] = useState(
    pendingCreate?.visibleToClients ?? defaultVisibleToClients ?? false,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setTitle(initialTitle);
    setVisibleToClients(pendingCreate?.visibleToClients ?? defaultVisibleToClients ?? false);
    setError(null);
    setSaving(false);
  }, [open, initialTitle, defaultVisibleToClients, pendingCreate]);

  const effectiveDefaultCompanyId = pendingCreate?.companyId ?? defaultCompanyId;
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    if (!effectiveDefaultCompanyId) {
      setCompany((cur) => (cur === null ? cur : null));
      return;
    }
    void (async () => {
      const res = await apiFetch<CompanyDetail>(
        `/companies/${effectiveDefaultCompanyId}`,
      );
      if (cancelled) return;
      if (res.ok && res.data) {
        setCompany({
          id: res.data.id,
          name: res.data.name,
          slug: res.data.slug,
          archivedAt: res.data.archivedAt,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, effectiveDefaultCompanyId]);

  const companyId = company?.id ?? null;
  useEffect(() => {
    if (!open || !companyId) {
      setFolderId((cur) => (cur === null ? cur : null));
      setFolders((cur) => (cur.length === 0 ? cur : []));
      return;
    }
    let cancelled = false;
    void (async () => {
      const res = await apiFetch<{ items: FolderNode[] }>(
        `/companies/${companyId}/folders/tree`,
      );
      if (cancelled) return;
      // Locked mode keeps the marker's folder; free mode resets on a
      // company change as before.
      setFolderId(pendingCreate ? pendingCreate.folderId : null);
      setFolders(res.ok && res.data ? res.data.items : []);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, companyId, pendingCreate]);

  const flatFolders = useMemo(() => flattenFolderTree(folders), [folders]);

  const canSubmit = !!company && title.trim().length > 0 && !saving;

  async function submit() {
    if (!company) return;
    const t = title.trim();
    if (!t) {
      setError('Title is required.');
      return;
    }
    const body = parsed.body;
    if (!body.trim()) {
      setError('The assistant response is empty.');
      return;
    }
    setError(null);
    setSaving(true);

    if (applyToolCall) {
      const result = await applyToolCall({
        companyId: company.id,
        title: t,
        folderId,
        visibleToClients,
      });
      setSaving(false);
      if (!result.ok) {
        setError(result.error || 'Could not create the article.');
        return;
      }
      toast.push('Article created', 'ok');
      onClose();
      // Navigate to the new article when the apply path could resolve
      // the id, otherwise just close — the chat-side "applied" badge
      // already confirms the action and a follow-up route refresh
      // keeps any company-scoped listings in sync.
      if (result.articleId) {
        router.push(
          `/admin/companies/${company.id}/articles/${result.articleId}`,
        );
      }
      router.refresh();
      return;
    }

    const res = await apiFetch<{ id: string }>(
      `/companies/${company.id}/articles`,
      {
        method: 'POST',
        body: JSON.stringify({
          title: t,
          folderId: folderId ?? undefined,
          visibleToClients,
          editorMode: 'markdown',
          markdownSource: body,
        }),
      },
    );
    setSaving(false);
    if (!res.ok || !res.data) {
      setError(extractErr(res.problem) ?? 'Could not create the article.');
      return;
    }
    toast.push('Article created', 'ok');
    const newId = res.data.id;
    onClose();
    router.push(`/admin/companies/${company.id}/articles/${newId}`);
    router.refresh();
  }

  return (
    <Dialog
      open={open}
      onClose={() => {
        if (!saving) onClose();
      }}
      title={dialogTitle ?? 'Save as article'}
      width={460}
      footer={
        <>
          <Btn kind="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Btn>
          <Btn
            kind="primary"
            onClick={submit}
            disabled={!canSubmit}
            loading={saving}
          >
            {submitLabel ?? 'Create article'}
          </Btn>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {locked && (
          <div
            style={{
              padding: '8px 10px',
              borderRadius: 5,
              background: 'var(--accent-soft)',
              color: 'var(--text)',
              fontSize: 12.5,
            }}
          >
            A previous apply didn’t finish — completing the original
            confirmation.
          </div>
        )}
        <Field label="Title">
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Article title"
            autoFocus={!locked}
            disabled={saving || locked}
          />
        </Field>

        <Field label="Company">
          {locked ? (
            <Input value={company?.name ?? 'Loading…'} disabled readOnly />
          ) : (
            <CompanyPicker
              value={company}
              onChange={(next) => setCompany(next)}
              placeholder="Search for a company…"
            />
          )}
        </Field>

        {company && (
          <Field label="Folder">
            <Select
              value={folderId ?? ''}
              onChange={(e) => setFolderId(e.target.value || null)}
              disabled={saving || locked}
            >
              <option value="">— unfiled —</option>
              {flatFolders.map((f) => (
                <option key={f.id} value={f.id}>
                  {'· '.repeat(f.depth)}
                  {f.name}
                </option>
              ))}
            </Select>
          </Field>
        )}

        <label
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            fontSize: 13,
            color: 'var(--text)',
            cursor: 'pointer',
          }}
        >
          <input
            type="checkbox"
            checked={visibleToClients}
            onChange={(e) => setVisibleToClients(e.target.checked)}
            style={{ accentColor: 'var(--accent)' }}
            disabled={saving || locked}
          />
          Visible to clients
        </label>

        {error && (
          <div
            role="alert"
            style={{
              padding: '8px 10px',
              borderRadius: 5,
              background: 'var(--danger-soft)',
              color: 'var(--danger)',
              fontSize: 12.5,
            }}
          >
            {error}
          </div>
        )}
      </div>
    </Dialog>
  );
}

function extractErr(problem: unknown): string | null {
  if (!problem || typeof problem !== 'object') return null;
  const p = problem as { detail?: unknown; title?: unknown; message?: unknown };
  for (const key of ['detail', 'message', 'title'] as const) {
    const v = p[key];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return null;
}
