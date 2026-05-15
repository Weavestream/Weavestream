'use client';

import { useMemo, useState } from 'react';
import type { TicketActivity, TicketDetail } from '../../../../../../lib/server-api';
import { Icon, Tag } from '../../../../../../components/ui';

/**
 * Phase 12 — ticket detail surface. Description + chronological
 * activity timeline + attachments index + collapsible provider-
 * extras panel for the `raw` bag. Everything is read-only — the
 * chat panel auto-attaches this ticket so the operator can ask the
 * AI to draft an article from the same screen.
 */
export function TicketDetailView({
  ticket,
  actorId: _actorId,
}: {
  ticket: TicketDetail;
  actorId: string;
}) {
  const [extrasOpen, setExtrasOpen] = useState(false);

  const rawEntries = useMemo(() => {
    const out: { key: string; value: string }[] = [];
    for (const [k, v] of Object.entries(ticket.raw ?? {})) {
      if (v == null) continue;
      let s: string;
      if (typeof v === 'string') s = v;
      else {
        try {
          s = JSON.stringify(v, null, 2);
        } catch {
          s = String(v);
        }
      }
      if (s.length > 4_000) s = `${s.slice(0, 4_000)}…`;
      out.push({ key: k, value: s });
    }
    out.sort((a, b) => a.key.localeCompare(b.key));
    return out;
  }, [ticket.raw]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <header
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
        }}
      >
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            color: 'var(--dim)',
            textTransform: 'uppercase',
            letterSpacing: 0.5,
          }}
        >
          {ticket.provider}
        </div>
        <div
          style={{
            display: 'flex',
            gap: 16,
            flexWrap: 'wrap',
            color: 'var(--text-2)',
            fontSize: 12.5,
          }}
        >
          {ticket.createdAt && (
            <Meta label="Created">{formatIso(ticket.createdAt)}</Meta>
          )}
          {ticket.updatedAt && (
            <Meta label="Updated">{formatIso(ticket.updatedAt)}</Meta>
          )}
        </div>
      </header>

      {ticket.description && ticket.description.trim().length > 0 ? (
        <section>
          <SectionTitle>Description</SectionTitle>
          <BodyBlock body={ticket.description} />
        </section>
      ) : (
        <section
          style={{
            padding: '12px 0',
            color: 'var(--muted)',
            fontSize: 13,
            fontStyle: 'italic',
          }}
        >
          No description on this ticket.
        </section>
      )}

      <section>
        <SectionTitle>
          Activity{' '}
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              color: 'var(--dim)',
              fontWeight: 400,
              marginLeft: 6,
            }}
          >
            {ticket.activities.length}
          </span>
        </SectionTitle>
        {ticket.activities.length === 0 ? (
          <div style={{ color: 'var(--muted)', fontSize: 13 }}>
            No activity recorded.
          </div>
        ) : (
          <ol
            style={{
              listStyle: 'none',
              margin: 0,
              padding: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
            }}
          >
            {ticket.activities.map((a) => (
              <li key={a.id}>
                <ActivityEntry activity={a} />
              </li>
            ))}
          </ol>
        )}
      </section>

      {ticket.attachments.length > 0 && (
        <section>
          <SectionTitle>Attachments</SectionTitle>
          <ul
            style={{
              listStyle: 'none',
              margin: 0,
              padding: 0,
              display: 'flex',
              flexWrap: 'wrap',
              gap: 8,
            }}
          >
            {ticket.attachments.map((att) => (
              <li
                key={att.id}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '6px 10px',
                  background: 'var(--panel-2)',
                  border: '1px solid var(--line-2)',
                  borderRadius: 5,
                  fontSize: 12,
                }}
              >
                <Icon.doc size={12} style={{ color: 'var(--dim)' }} />
                <span
                  style={{
                    maxWidth: 240,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {att.name}
                </span>
                {att.sizeBytes != null && (
                  <span
                    style={{
                      fontFamily: 'var(--font-mono)',
                      color: 'var(--dim)',
                    }}
                  >
                    {humanBytes(att.sizeBytes)}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {rawEntries.length > 0 && (
        <section>
          <button
            type="button"
            onClick={() => setExtrasOpen((v) => !v)}
            style={{
              background: 'transparent',
              border: '1px dashed var(--line-2)',
              padding: '6px 10px',
              borderRadius: 5,
              color: 'var(--muted)',
              fontFamily: 'var(--font-mono)',
              fontSize: 11.5,
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <Icon.chevron
              size={11}
              style={{
                transform: extrasOpen ? 'rotate(90deg)' : 'none',
                transition: 'transform 120ms ease',
              }}
            />
            Provider details ({rawEntries.length})
          </button>
          {extrasOpen && (
            <dl
              style={{
                marginTop: 10,
                display: 'grid',
                gridTemplateColumns: 'max-content 1fr',
                columnGap: 14,
                rowGap: 6,
                fontFamily: 'var(--font-mono)',
                fontSize: 11.5,
              }}
            >
              {rawEntries.map((e) => (
                <RawEntry key={e.key} entry={e} />
              ))}
            </dl>
          )}
        </section>
      )}
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2
      style={{
        margin: '0 0 8px',
        fontSize: 13,
        fontWeight: 600,
        color: 'var(--text)',
        display: 'flex',
        alignItems: 'center',
      }}
    >
      {children}
    </h2>
  );
}

function Meta({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <span style={{ display: 'inline-flex', gap: 6 }}>
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 10.5,
          color: 'var(--dim)',
          textTransform: 'uppercase',
          letterSpacing: 0.5,
        }}
      >
        {label}
      </span>
      <span>{children}</span>
    </span>
  );
}

function ActivityEntry({ activity }: { activity: TicketActivity }) {
  const tone = activity.kind === 'internal_note' ? 'warn' : 'outline';
  return (
    <div
      style={{
        border: '1px solid var(--line)',
        borderLeft:
          activity.kind === 'internal_note'
            ? '3px solid var(--warn)'
            : '1px solid var(--line)',
        borderRadius: 5,
        padding: '10px 12px',
        background:
          activity.kind === 'internal_note'
            ? 'var(--warn-soft)'
            : 'var(--panel-2)',
      }}
    >
      <div
        style={{
          display: 'flex',
          gap: 8,
          alignItems: 'center',
          flexWrap: 'wrap',
        }}
      >
        <Tag tone={tone}>{activity.label}</Tag>
        {activity.author?.name && (
          <span style={{ fontSize: 12, color: 'var(--text-2)' }}>
            {activity.author.name}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            color: 'var(--dim)',
          }}
        >
          {formatIso(activity.occurredAt)}
        </span>
      </div>
      {activity.body && activity.body.trim().length > 0 ? (
        <div style={{ marginTop: 8 }}>
          <BodyBlock body={activity.body} />
        </div>
      ) : null}
    </div>
  );
}

function BodyBlock({ body }: { body: string }) {
  return (
    <pre
      style={{
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        margin: 0,
        fontFamily: 'inherit',
        fontSize: 13,
        lineHeight: 1.55,
        color: 'var(--text)',
        background: 'transparent',
      }}
    >
      {body}
    </pre>
  );
}

function RawEntry({ entry }: { entry: { key: string; value: string } }) {
  const multiline = entry.value.includes('\n') || entry.value.length > 80;
  return (
    <>
      <dt style={{ color: 'var(--muted)', whiteSpace: 'nowrap' }}>{entry.key}</dt>
      <dd style={{ margin: 0, color: 'var(--text)' }}>
        {multiline ? (
          <pre
            style={{
              margin: 0,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {entry.value}
          </pre>
        ) : (
          <span>{entry.value}</span>
        )}
      </dd>
    </>
  );
}

function formatIso(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

function humanBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let val = n;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i += 1;
  }
  return `${val.toFixed(val >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}
