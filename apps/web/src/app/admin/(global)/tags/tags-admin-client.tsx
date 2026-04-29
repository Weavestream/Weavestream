'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import { apiFetch } from '../../../../lib/api';
import { Btn, Icon, useToast } from '../../../../components/ui';

type TagRow = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
};

const controlStyle: CSSProperties = {
  background: 'var(--panel)',
  border: '1px solid var(--line-2)',
  borderRadius: 4,
  padding: '7px 10px',
  fontSize: 13,
  color: 'var(--text)',
  outline: 'none',
  fontFamily: 'inherit',
  boxSizing: 'border-box',
};

export function TagsAdminClient() {
  const toast = useToast();
  const [q, setQ] = useState('');
  const [items, setItems] = useState<TagRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      const params = new URLSearchParams();
      if (q.trim()) params.set('q', q.trim());
      params.set('limit', '200');
      const res = await apiFetch<{ items: TagRow[] }>(
        `/tags${params.toString() ? `?${params.toString()}` : ''}`,
        { signal: ctrl.signal },
      );
      if (res.ok && res.data) {
        setItems(res.data.items);
        setError(null);
      } else if (res.status !== 0) {
        setError('Failed to load tags.');
      }
    }, 150);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q]);

  function startEdit(row: TagRow) {
    setEditingId(row.id);
    setEditingName(row.name);
  }
  function cancelEdit() {
    setEditingId(null);
    setEditingName('');
  }

  async function saveRename(row: TagRow) {
    const name = editingName.trim();
    if (!name) {
      cancelEdit();
      return;
    }
    if (name === row.name) {
      cancelEdit();
      return;
    }
    setBusyId(row.id);
    const res = await apiFetch<TagRow>(`/tags/${row.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    });
    setBusyId(null);
    if (!res.ok || !res.data) {
      const p = res.problem as { message?: string; detail?: string } | undefined;
      toast.push(p?.message ?? p?.detail ?? 'Rename failed', 'danger');
      return;
    }
    setItems((cur) =>
      cur ? cur.map((t) => (t.id === row.id ? res.data! : t)) : cur,
    );
    cancelEdit();
    toast.push('Tag renamed', 'ok');
  }

  async function remove(row: TagRow) {
    if (
      !window.confirm(
        `Delete tag "${row.name}"? Existing asset references will silently disappear on next read.`,
      )
    ) {
      return;
    }
    setBusyId(row.id);
    const res = await apiFetch(`/tags/${row.id}`, { method: 'DELETE' });
    setBusyId(null);
    if (!res.ok) {
      const p = res.problem as { message?: string; detail?: string } | undefined;
      toast.push(p?.message ?? p?.detail ?? 'Delete failed', 'danger');
      return;
    }
    setItems((cur) => (cur ? cur.filter((t) => t.id !== row.id) : cur));
    toast.push('Tag deleted', 'ok');
  }

  return (
    <div>
      <div
        style={{
          padding: '10px 14px',
          borderBottom: '1px solid var(--line)',
          display: 'flex',
          gap: 8,
          alignItems: 'center',
        }}
      >
        <div
          style={{
            flex: 1,
            minWidth: 180,
            maxWidth: 360,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            height: 28,
            padding: '0 10px',
            background: 'var(--panel-2)',
            border: '1px solid var(--line)',
            borderRadius: 5,
          }}
        >
          <Icon.search size={12} style={{ color: 'var(--muted)' }} />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search tags…"
            style={{
              flex: 1,
              background: 'transparent',
              border: 'none',
              outline: 'none',
              fontSize: 12.5,
              color: 'var(--text)',
            }}
          />
        </div>
        <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>
          {items ? `${items.length} tag${items.length === 1 ? '' : 's'}` : '…'}
        </span>
      </div>
      {error && (
        <div
          role="alert"
          style={{
            padding: '10px 14px',
            background: 'var(--danger-soft)',
            color: 'var(--danger)',
            fontSize: 12.5,
          }}
        >
          {error}
        </div>
      )}
      {items === null ? (
        <div
          style={{
            padding: '24px 14px',
            color: 'var(--muted)',
            fontSize: 12.5,
            textAlign: 'center',
          }}
        >
          Loading tags…
        </div>
      ) : items.length === 0 ? (
        <div
          style={{
            padding: '40px 14px',
            color: 'var(--muted)',
            fontSize: 13,
            textAlign: 'center',
          }}
        >
          {q.trim()
            ? 'No tags match that search.'
            : 'No tags yet. Tags appear here once an operator types one on an asset.'}
        </div>
      ) : (
        <div>
          {(items ?? []).map((row) => {
            const isEditing = editingId === row.id;
            const busy = busyId === row.id;
            return (
              <div
                key={row.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '10px 14px',
                  borderBottom: '1px solid var(--line)',
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  {isEditing ? (
                    <input
                      value={editingName}
                      onChange={(e) => setEditingName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          saveRename(row);
                        } else if (e.key === 'Escape') {
                          cancelEdit();
                        }
                      }}
                      autoFocus
                      disabled={busy}
                      style={{ ...controlStyle, width: '100%', maxWidth: 360 }}
                    />
                  ) : (
                    <span style={{ fontSize: 13 }}>{row.name}</span>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  {isEditing ? (
                    <>
                      <Btn
                        size="sm"
                        kind="primary"
                        icon={Icon.check}
                        onClick={() => saveRename(row)}
                        loading={busy}
                      >
                        Save
                      </Btn>
                      <Btn
                        size="sm"
                        kind="ghost"
                        icon={Icon.x}
                        onClick={cancelEdit}
                        disabled={busy}
                      >
                        Cancel
                      </Btn>
                    </>
                  ) : (
                    <>
                      <Btn
                        size="sm"
                        kind="ghost"
                        icon={Icon.edit}
                        onClick={() => startEdit(row)}
                        disabled={busy}
                      >
                        Rename
                      </Btn>
                      <Btn
                        size="sm"
                        kind="ghost"
                        icon={Icon.trash}
                        onClick={() => remove(row)}
                        loading={busy}
                      >
                        Delete
                      </Btn>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
