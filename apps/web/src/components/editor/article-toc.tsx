'use client';

import { useEffect, useState } from 'react';

/**
 * Right rail of the admin article read view.
 *
 * Two stacked blocks inside a 240px aside:
 *   1. "On this page" — scans the rendered `.sd-richtext-view` subtree
 *      for h1/h2/h3 nodes, assigns slugified ids to any that lack one,
 *      and renders them as anchor links with an accent bar on whichever
 *      heading is currently closest to the top of the viewport (tracked
 *      via IntersectionObserver).
 *   2. "Last activity" — a compact card showing resolved display names
 *      for `createdBy` and `updatedBy` with relative timestamps. This is
 *      a pragmatic stand-in for the design's "Authors" card; once we add
 *      real revision history it can be swapped for per-author edit
 *      counts without changing any layout around it.
 *
 * The headings list re-scans when the article content changes (we key
 * the effect on the article id + updated timestamp passed in).
 */
export function ArticleToc({
  articleId,
  articleUpdatedAt,
  createdBy,
  createdAt,
  updatedBy,
  updatedAt,
}: {
  articleId: string;
  articleUpdatedAt: string;
  createdBy: { id: string; displayName: string } | null;
  createdAt: string;
  updatedBy: { id: string; displayName: string } | null;
  updatedAt: string;
}) {
  type Heading = { id: string; text: string; level: 1 | 2 | 3 };
  const [headings, setHeadings] = useState<Heading[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    // Tiptap mounts asynchronously inside RichTextView (`immediatelyRender:
    // false`), so the headings aren't necessarily in the DOM on the first
    // tick. We poll a few animation frames until content appears, then
    // commit the list and wire up the scroll observer.
    let raf = 0;
    let tries = 0;

    const collect = () => {
      const root = document.querySelector('.sd-richtext-view');
      if (!root) {
        if (tries++ < 30) {
          raf = requestAnimationFrame(collect);
        }
        return;
      }
      const nodes = root.querySelectorAll('h1, h2, h3');
      if (nodes.length === 0) {
        if (tries++ < 30) {
          raf = requestAnimationFrame(collect);
        } else {
          setHeadings([]);
        }
        return;
      }
      const list: Heading[] = [];
      const usedIds = new Set<string>();
      nodes.forEach((el) => {
        const tag = el.tagName.toLowerCase();
        const level = (tag === 'h1' ? 1 : tag === 'h2' ? 2 : 3) as 1 | 2 | 3;
        const text = (el.textContent ?? '').trim();
        if (!text) return;
        let id = el.id;
        if (!id) {
          id = slugify(text);
          let n = 2;
          let candidate = id;
          while (usedIds.has(candidate)) {
            candidate = `${id}-${n++}`;
          }
          id = candidate;
          el.id = id;
        }
        usedIds.add(id);
        list.push({ id, text, level });
      });
      setHeadings(list);
    };

    raf = requestAnimationFrame(collect);
    return () => cancelAnimationFrame(raf);
    // Re-run when the article identity OR its content changes.
  }, [articleId, articleUpdatedAt]);

  useEffect(() => {
    if (headings.length === 0) return;
    const elements = headings
      .map((h) => document.getElementById(h.id))
      .filter((el): el is HTMLElement => el !== null);
    if (elements.length === 0) return;

    // Track which heading is nearest the top of the viewport. Because
    // multiple headings can intersect the root simultaneously (long
    // screen), we pick the one with the smallest positive top.
    const visibility = new Map<string, number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const rect = entry.boundingClientRect;
          visibility.set(entry.target.id, entry.isIntersecting ? rect.top : Infinity);
        }
        let bestId: string | null = null;
        let bestTop = Infinity;
        for (const [id, top] of visibility.entries()) {
          if (top >= -8 && top < bestTop) {
            bestTop = top;
            bestId = id;
          }
        }
        if (!bestId) {
          // Fallback: pick the last heading whose top is above the viewport.
          let above: string | null = null;
          for (const el of elements) {
            if (el.getBoundingClientRect().top < 0) above = el.id;
            else break;
          }
          bestId = above ?? elements[0]?.id ?? null;
        }
        setActiveId(bestId);
      },
      { rootMargin: '-8px 0px -70% 0px', threshold: [0, 1] },
    );
    for (const el of elements) observer.observe(el);
    return () => observer.disconnect();
  }, [headings]);

  const hasActivity = createdBy || updatedBy;

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <SectionLabel>On this page</SectionLabel>
      {headings.length === 0 ? (
        <div
          style={{
            fontSize: 11.5,
            color: 'var(--dim)',
            fontFamily: 'var(--font-mono)',
            marginTop: 4,
          }}
        >
          no headings yet
        </div>
      ) : (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
            borderLeft: '1px solid var(--line)',
            marginTop: 6,
          }}
        >
          {headings.map((h) => {
            const isActive = h.id === activeId;
            return (
              <a
                key={h.id}
                href={`#${h.id}`}
                onClick={(e) => {
                  e.preventDefault();
                  const el = document.getElementById(h.id);
                  if (el) {
                    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    // Nudge the URL hash without clobbering scroll position.
                    history.replaceState(null, '', `#${h.id}`);
                  }
                }}
                style={{
                  padding: '4px 12px',
                  paddingLeft: 12 + (h.level - 1) * 10,
                  fontSize: 12.5,
                  color: isActive ? 'var(--accent)' : 'var(--muted)',
                  borderLeft: `2px solid ${
                    isActive ? 'var(--accent)' : 'transparent'
                  }`,
                  marginLeft: -1,
                  textDecoration: 'none',
                  lineHeight: 1.4,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {h.text}
              </a>
            );
          })}
        </div>
      )}

      {hasActivity && (
        <div
          style={{
            marginTop: 24,
            paddingTop: 18,
            borderTop: '1px solid var(--line)',
          }}
        >
          <SectionLabel>Last activity</SectionLabel>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10 }}>
            {createdBy && (
              <PersonRow
                name={createdBy.displayName}
                role={`created ${timeAgo(createdAt)}`}
              />
            )}
            {updatedBy && updatedBy.id !== createdBy?.id && (
              <PersonRow
                name={updatedBy.displayName}
                role={`updated ${timeAgo(updatedAt)}`}
              />
            )}
            {updatedBy && createdBy && updatedBy.id === createdBy.id && (
              <div
                style={{
                  fontSize: 11,
                  color: 'var(--dim)',
                  fontFamily: 'var(--font-mono)',
                  paddingLeft: 30,
                }}
              >
                also last edit · {timeAgo(updatedAt)}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 11,
        color: 'var(--muted)',
        fontFamily: 'var(--font-mono)',
        textTransform: 'uppercase',
        letterSpacing: 0.5,
        marginBottom: 6,
      }}
    >
      {children}
    </div>
  );
}

function PersonRow({ name, role }: { name: string; role: string }) {
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <div
        style={{
          width: 22,
          height: 22,
          borderRadius: '50%',
          background: 'var(--panel-2)',
          border: '1px solid var(--line-2)',
          fontSize: 10,
          fontWeight: 600,
          display: 'grid',
          placeItems: 'center',
          color: 'var(--text)',
          flexShrink: 0,
        }}
      >
        {initials(name)}
      </div>
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            fontSize: 12,
            color: 'var(--text)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {name}
        </div>
        <div
          style={{
            fontSize: 10.5,
            color: 'var(--dim)',
            fontFamily: 'var(--font-mono)',
          }}
        >
          {role}
        </div>
      </div>
    </div>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '')
      .slice(0, 80) || 'section'
  );
}

function timeAgo(iso: string): string {
  const d = new Date(iso);
  const sec = Math.max(1, Math.round((Date.now() - d.getTime()) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.round(h / 24);
  if (days < 14) return `${days}d ago`;
  return d.toLocaleDateString();
}
