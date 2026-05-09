'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Btn, Icon, Panel, Tag, useToast } from '../ui';
import { apiFetch } from '../../lib/api';
import { AddLinkModal } from './add-link-modal';
import type {
  LinkedItem,
  ListRelatedResponse,
  RelationEndpointKind,
} from './types';

interface Props {
  companyId: string;
  entityType: RelationEndpointKind;
  entityId: string;
  /** Writer can open the Add-Link modal and unlink rows. */
  editable: boolean;
}

const GROUP_LABELS: Record<RelationEndpointKind, string> = {
  asset: 'Assets',
  article: 'Articles',
  password: 'Passwords',
};

const GROUP_ORDER: RelationEndpointKind[] = ['asset', 'article', 'password'];

/**
 * Phase 5 right-rail panel: shows every Relation row where the given
 * entity is on either end, grouped by kind. Writers see the "Add link"
 * button and per-row unlink affordance; readers see a static list.
 *
 * The component owns its own refresh loop — it re-fetches after any
 * successful link / unlink so the UI reflects server truth without a
 * page reload.
 */
export function LinkedItemsPanel({ companyId, entityType, entityId, editable }: Props) {
  const [state, setState] = useState<ListRelatedResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const toast = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await apiFetch<ListRelatedResponse>(
      `/companies/${companyId}/relations?entityType=${entityType}&entityId=${entityId}`,
    );
    if (!res.ok || !res.data) {
      setError('Could not load linked items.');
      setState(null);
    } else {
      setState(res.data);
    }
    setLoading(false);
  }, [companyId, entityType, entityId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleUnlink(item: LinkedItem) {
    if (!confirm(`Unlink "${item.title}"?`)) return;
    const res = await apiFetch(`/companies/${companyId}/relations/${item.relationId}`, {
      method: 'DELETE',
    });
    if (!res.ok) {
      const problem = (res.problem ?? res.data) as { detail?: string; message?: string } | null;
      toast.push(problem?.detail ?? problem?.message ?? 'Could not unlink.', 'danger');
      return;
    }
    toast.push('Unlinked.', 'ok');
    void load();
  }

  return (
    <>
      <Panel
        title={
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Icon.link size={12} style={{ color: 'var(--accent)' }} />
            Linked items
            {state && state.totalCount > 0 && (
              <span
                style={{
                  color: 'var(--muted)',
                  fontFamily: 'var(--font-mono)',
                  marginLeft: 2,
                }}
              >
                · {state.totalCount}
              </span>
            )}
          </span>
        }
        actions={
          editable ? (
            <Btn
              kind="ghost"
              size="sm"
              icon={Icon.plus}
              onClick={() => setModalOpen(true)}
              aria-label="Add link"
            >
              Add
            </Btn>
          ) : null
        }
      >
        {loading ? (
          <div style={emptyStyle}>Loading…</div>
        ) : error ? (
          <div style={{ ...emptyStyle, color: 'var(--danger)' }}>{error}</div>
        ) : !state || state.totalCount === 0 ? (
          <div style={emptyStyle}>
            No links yet.
            {editable && (
              <>
                {' '}
                <button
                  type="button"
                  onClick={() => setModalOpen(true)}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: 'var(--accent)',
                    cursor: 'pointer',
                    fontSize: 'inherit',
                    padding: 0,
                  }}
                >
                  Add the first.
                </button>
              </>
            )}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {GROUP_ORDER.map((kind) => {
              const rows = state.groups[kind];
              if (!rows || rows.length === 0) return null;
              return (
                <section key={kind}>
                  <div style={sectionHeaderStyle}>
                    <span>{GROUP_LABELS[kind]}</span>
                    <span style={{ color: 'var(--dim)' }}>{rows.length}</span>
                  </div>
                  <ul
                    style={{
                      listStyle: 'none',
                      margin: 0,
                      padding: 0,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 4,
                    }}
                  >
                    {rows.map((item) => (
                      <li key={item.relationId}>
                        <LinkedRow
                          item={item}
                          editable={editable}
                          onUnlink={() => handleUnlink(item)}
                        />
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
        )}
      </Panel>

      {editable && (
        <AddLinkModal
          open={modalOpen}
          onClose={() => setModalOpen(false)}
          onLinked={() => void load()}
          companyId={companyId}
          sourceType={entityType}
          sourceId={entityId}
          existing={state?.items ?? []}
        />
      )}
    </>
  );
}

function LinkedRow({
  item,
  editable,
  onUnlink,
}: {
  item: LinkedItem;
  editable: boolean;
  onUnlink: () => void;
}) {
  const KindIcon =
    item.kind === 'asset' ? Icon.box : item.kind === 'password' ? Icon.lock : Icon.doc;
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 4px',
        borderRadius: 4,
        transition: 'background-color 120ms ease',
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--panel-2)')}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
    >
      <span
        aria-hidden
        style={{
          width: 20,
          height: 20,
          display: 'grid',
          placeItems: 'center',
          color:
            item.color ??
            (item.kind === 'asset'
              ? 'var(--accent)'
              : item.kind === 'password'
                ? 'var(--warn)'
                : 'var(--info)'),
          flexShrink: 0,
        }}
      >
        <KindIcon size={13} />
      </span>
      <Link
        href={item.href}
        style={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: 1,
          color: 'var(--text)',
          textDecoration: 'none',
        }}
      >
        <span
          style={{
            fontSize: 12.5,
            fontWeight: 500,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {item.title}
        </span>
        <span
          style={{
            fontSize: 10.5,
            color: 'var(--muted)',
            fontFamily: 'var(--font-mono)',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            flexWrap: 'wrap',
            minWidth: 0,
          }}
        >
          {item.subtitle && (
            <span
              style={{
                flex: '1 1 100%',
                minWidth: 0,
                overflowWrap: 'anywhere',
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
              }}
            >
              {item.subtitle}
            </span>
          )}
          {item.relationType && item.relationType !== 'manual' && (
            <Tag tone={item.isFieldManaged ? 'outline' : 'info'}>{item.relationType}</Tag>
          )}
          {item.direction === 'incoming' && (
            <span title="This item links to the current page" style={{ color: 'var(--dim)' }}>
              ← incoming
            </span>
          )}
        </span>
      </Link>
      {editable && (
        <button
          type="button"
          onClick={onUnlink}
          title={
            item.isFieldManaged
              ? 'This link is maintained by an asset field — removing it will recreate on next save.'
              : 'Unlink'
          }
          aria-label="Unlink"
          style={{
            background: 'transparent',
            border: 'none',
            color: 'var(--muted)',
            cursor: 'pointer',
            padding: 4,
            borderRadius: 3,
            display: 'grid',
            placeItems: 'center',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = 'var(--danger)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = 'var(--muted)';
          }}
        >
          <Icon.x size={11} />
        </button>
      )}
    </div>
  );
}

const emptyStyle = {
  padding: '18px 4px',
  fontSize: 12,
  color: 'var(--muted)',
  textAlign: 'center' as const,
};

const sectionHeaderStyle = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: '0 2px 4px',
  fontSize: 10.5,
  fontFamily: 'var(--font-mono)',
  color: 'var(--muted)',
  textTransform: 'uppercase' as const,
  letterSpacing: 0.6,
};
