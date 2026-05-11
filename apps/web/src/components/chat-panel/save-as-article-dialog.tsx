'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { splitMarkdownTitleAndBody } from '@weavestream/shared';
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
 */
export function SaveAsArticleDialog({
  open,
  markdown,
  defaultCompanyId,
  onClose,
}: {
  open: boolean;
  markdown: string;
  defaultCompanyId: string | null;
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
  const [title, setTitle] = useState(parsed.title);
  const [company, setCompany] = useState<CompanyPickerValue | null>(null);
  const [folders, setFolders] = useState<FolderNode[]>([]);
  const [folderId, setFolderId] = useState<string | null>(null);
  const [visibleToClients, setVisibleToClients] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setTitle(parsed.title);
    setError(null);
    setSaving(false);
  }, [open, parsed.title]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    if (!defaultCompanyId) {
      setCompany((cur) => (cur === null ? cur : null));
      return;
    }
    void (async () => {
      const res = await apiFetch<CompanyDetail>(
        `/companies/${defaultCompanyId}`,
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
  }, [open, defaultCompanyId]);

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
      setFolderId(null);
      setFolders(res.ok && res.data ? res.data.items : []);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, companyId]);

  const flatFolders = useMemo(() => flattenFolders(folders), [folders]);

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
      title="Save as article"
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
            Create article
          </Btn>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Field label="Title">
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Article title"
            autoFocus
            disabled={saving}
          />
        </Field>

        <Field label="Company">
          <CompanyPicker
            value={company}
            onChange={(next) => setCompany(next)}
            placeholder="Search for a company…"
          />
        </Field>

        {company && (
          <Field label="Folder">
            <Select
              value={folderId ?? ''}
              onChange={(e) => setFolderId(e.target.value || null)}
              disabled={saving}
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
            disabled={saving}
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

type FlatFolder = { id: string; name: string; depth: number };

function flattenFolders(nodes: FolderNode[], depth = 0): FlatFolder[] {
  const out: FlatFolder[] = [];
  for (const n of nodes) {
    out.push({ id: n.id, name: n.name, depth });
    if (n.children.length > 0) {
      out.push(...flattenFolders(n.children, depth + 1));
    }
  }
  return out;
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
