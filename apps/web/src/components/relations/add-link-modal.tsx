'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Btn, Dialog, Field, Icon, Input, Tag, useToast } from '../ui';
import { apiFetch } from '../../lib/api';
import type { LinkedItem, MentionSearchItem, RelationEndpointKind } from './types';

interface Props {
  open: boolean;
  onClose: () => void;
  onLinked: () => void;
  companyId: string;
  sourceType: RelationEndpointKind;
  sourceId: string;
  /** Already-linked items — used to grey out rows and suppress duplicates. */
  existing: LinkedItem[];
}

/**
 * Search + pick a target Asset/Article from the current company, attach
 * an optional relationType label, POST the link. The picker reuses the
 * Phase-4 `/search/mentions` endpoint for parity with the Tiptap `@`
 * extension — results are already scoped to the caller's memberships +
 * client visibility.
 */
export function AddLinkModal({
  open,
  onClose,
  onLinked,
  companyId,
  sourceType,
  sourceId,
  existing,
}: Props) {
  const toast = useToast();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<MentionSearchItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<MentionSearchItem | null>(null);
  const [relationType, setRelationType] = useState('');
  const [labelSuggestions, setLabelSuggestions] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const existingKeys = useMemo(() => {
    const set = new Set<string>();
    for (const item of existing) set.add(`${item.kind}:${item.id}`);
    return set;
  }, [existing]);

  useEffect(() => {
    if (!open) return;
    setQ('');
    setResults([]);
    setSelected(null);
    setRelationType('');
    const t = setTimeout(() => inputRef.current?.focus(), 30);
    return () => clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    (async () => {
      const res = await apiFetch<{ items: string[] }>(
        `/companies/${companyId}/relations/labels`,
      );
      if (res.ok && res.data) setLabelSuggestions(res.data.items);
    })();
  }, [open, companyId]);

  useEffect(() => {
    if (!open) return;
    const needle = q.trim();
    if (needle.length === 0) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      const res = await apiFetch<{ items: MentionSearchItem[] }>(
        `/search/mentions?q=${encodeURIComponent(needle)}&companyId=${companyId}&kinds=asset,article,password&limit=15`,
        { signal: controller.signal },
      );
      // Another keystroke already invalidated this fetch — bail out so we
      // don't overwrite the newer effect's loading state with a stale
      // result.
      if (controller.signal.aborted) return;
      if (res.ok && res.data) setResults(res.data.items);
      setSearching(false);
    }, 180);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [q, open, companyId]);

  async function handleSubmit() {
    if (!selected || submitting) return;
    setSubmitting(true);
    const body = JSON.stringify({
      sourceType,
      sourceId,
      targetType: selected.kind,
      targetId: selected.id,
      ...(relationType.trim() ? { relationType: relationType.trim() } : {}),
    });
    const res = await apiFetch<{ id: string }>(`/companies/${companyId}/relations`, {
      method: 'POST',
      body,
    });
    setSubmitting(false);
    if (!res.ok) {
      const problem = (res.problem ?? res.data) as { detail?: string; message?: string } | null;
      toast.push(problem?.detail ?? problem?.message ?? 'Could not link item.', 'danger');
      return;
    }
    toast.push('Linked.', 'ok');
    onLinked();
    onClose();
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add link"
      width={460}
      footer={
        <>
          <Btn kind="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Btn>
          <Btn
            kind="primary"
            onClick={handleSubmit}
            disabled={!selected || submitting}
            loading={submitting}
            icon={Icon.link}
          >
            Link
          </Btn>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Field
          label="Search"
          help="Type to search assets, articles, and passwords in this company."
        >
          <Input
            ref={inputRef}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setSelected(null);
            }}
            placeholder="Search assets, articles, or passwords…"
            autoComplete="off"
          />
        </Field>

        <div
          style={{
            border: '1px solid var(--line)',
            borderRadius: 6,
            background: 'var(--panel-2)',
            maxHeight: 260,
            overflowY: 'auto',
            minHeight: 140,
          }}
        >
          {q.trim().length === 0 ? (
            <div style={emptyStyle}>Start typing to search.</div>
          ) : searching ? (
            <div style={emptyStyle}>Searching…</div>
          ) : results.length === 0 ? (
            <div style={emptyStyle}>No matches.</div>
          ) : (
            results.map((r) => {
              const keyStr = `${r.kind}:${r.id}`;
              const isSelf = r.kind === sourceType && r.id === sourceId;
              const alreadyLinked = existingKeys.has(keyStr);
              const disabled = isSelf || alreadyLinked;
              const isSelected = selected?.kind === r.kind && selected.id === r.id;
              return (
                <button
                  key={keyStr}
                  type="button"
                  disabled={disabled}
                  onClick={() => setSelected(r)}
                  style={{
                    width: '100%',
                    textAlign: 'left',
                    padding: '9px 12px',
                    background: isSelected ? 'var(--accent-soft)' : 'transparent',
                    border: 'none',
                    borderBottom: '1px solid var(--line)',
                    cursor: disabled ? 'not-allowed' : 'pointer',
                    opacity: disabled ? 0.55 : 1,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    color: 'var(--text)',
                  }}
                >
                  <span
                    aria-hidden
                    style={{
                      width: 22,
                      height: 22,
                      display: 'grid',
                      placeItems: 'center',
                      color:
                        r.kind === 'asset'
                          ? 'var(--accent)'
                          : r.kind === 'password'
                            ? 'var(--warn)'
                            : 'var(--info)',
                    }}
                  >
                    {r.kind === 'asset' ? (
                      <Icon.box size={14} />
                    ) : r.kind === 'password' ? (
                      <Icon.lock size={14} />
                    ) : (
                      <Icon.doc size={14} />
                    )}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 13,
                        fontWeight: 500,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {r.title}
                    </div>
                    <div
                      style={{
                        fontSize: 11,
                        color: 'var(--muted)',
                        fontFamily: 'var(--font-mono)',
                        marginTop: 2,
                      }}
                    >
                      {r.kind === 'asset'
                        ? (r.layoutName ?? 'asset')
                        : r.kind === 'password'
                          ? 'password'
                          : 'article'}
                      {r.slug ? ` · ${r.slug}` : ''}
                    </div>
                  </div>
                  {alreadyLinked && <Tag tone="outline">linked</Tag>}
                  {isSelf && <Tag tone="outline">self</Tag>}
                </button>
              );
            })
          )}
        </div>

        <Field
          label="Relation type (optional)"
          help='Free-form label like "primary_user" or "depends_on". Defaults to "manual".'
        >
          <RelationTypeInput
            value={relationType}
            onChange={setRelationType}
            suggestions={labelSuggestions}
          />
        </Field>
      </div>
    </Dialog>
  );
}

const emptyStyle = {
  padding: '24px 12px',
  fontSize: 12.5,
  color: 'var(--muted)',
  textAlign: 'center' as const,
};

/**
 * Themed suggestion input. Native `<datalist>` renders with the browser's
 * default (usually bright) chrome and can't be styled to match the modal,
 * so we roll a tiny popover: shows on focus when we have suggestions,
 * hides on blur, supports keyboard nav (↑/↓/Enter/Esc).
 */
function RelationTypeInput({
  value,
  onChange,
  suggestions,
}: {
  value: string;
  onChange: (v: string) => void;
  suggestions: string[];
}) {
  const [focused, setFocused] = useState(false);
  const [hoverIdx, setHoverIdx] = useState(-1);

  const filtered = useMemo(() => {
    const needle = value.trim().toLowerCase();
    const list = needle
      ? suggestions.filter((s) => s.toLowerCase().includes(needle) && s.toLowerCase() !== needle)
      : suggestions;
    return list.slice(0, 8);
  }, [value, suggestions]);

  const open = focused && filtered.length > 0;

  return (
    <div style={{ position: 'relative' }}>
      <Input
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setHoverIdx(-1);
        }}
        onFocus={() => setFocused(true)}
        // Delay blur so a click on the list item can register first.
        onBlur={() => setTimeout(() => setFocused(false), 120)}
        onKeyDown={(e) => {
          if (!open) return;
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setHoverIdx((i) => Math.min(filtered.length - 1, i + 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setHoverIdx((i) => Math.max(-1, i - 1));
          } else if (e.key === 'Enter' && hoverIdx >= 0) {
            e.preventDefault();
            onChange(filtered[hoverIdx]!);
            setFocused(false);
          } else if (e.key === 'Escape') {
            setFocused(false);
          }
        }}
        placeholder="manual"
        maxLength={80}
        autoComplete="off"
      />
      {open && (
        <ul
          role="listbox"
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            right: 0,
            margin: 0,
            padding: 4,
            listStyle: 'none',
            background: 'var(--panel)',
            border: '1px solid var(--line)',
            borderRadius: 6,
            boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
            maxHeight: 180,
            overflowY: 'auto',
            zIndex: 10,
          }}
        >
          {filtered.map((label, i) => (
            <li key={label}>
              <button
                type="button"
                role="option"
                aria-selected={i === hoverIdx}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onChange(label);
                  setFocused(false);
                }}
                onMouseEnter={() => setHoverIdx(i)}
                style={{
                  width: '100%',
                  textAlign: 'left',
                  padding: '6px 8px',
                  background: i === hoverIdx ? 'var(--panel-2)' : 'transparent',
                  border: 'none',
                  borderRadius: 4,
                  color: 'var(--text)',
                  fontSize: 12.5,
                  fontFamily: 'var(--font-mono)',
                  cursor: 'pointer',
                }}
              >
                {label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
