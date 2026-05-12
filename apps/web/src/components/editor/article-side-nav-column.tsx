'use client';

import { useEffect, useRef, useState } from 'react';
import type { ArticleSummary, FolderNode } from '../../lib/server-api';
import { Icon } from '../ui';
import { ArticleSideNav } from './article-side-nav';

const STORAGE_KEY = 'weavestream.articleSideNav.collapsed';
const COLLAPSED_W = '32px';
const EXPANDED_W = '240px';

/**
 * Grid-cell wrapper for the article-read folder navigation. Owns the
 * collapsed/expanded state and writes the matching width to a CSS
 * variable on the parent `.article-read-grid` so the grid column shrinks
 * with the content (the grid template reads `var(--article-sidenav-w)`).
 * Persisted across reloads via localStorage.
 */
export function ArticleSideNavColumn(props: {
  companyId: string;
  folders: FolderNode[];
  articles: ArticleSummary[];
  activeArticleId: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    try {
      if (window.localStorage.getItem(STORAGE_KEY) === '1') setCollapsed(true);
    } catch {
      /* private mode or storage disabled — fall back to expanded */
    }
  }, []);

  useEffect(() => {
    const grid = ref.current?.closest('.article-read-grid') as HTMLElement | null;
    if (!grid) return;
    grid.style.setProperty(
      '--article-sidenav-w',
      collapsed ? COLLAPSED_W : EXPANDED_W,
    );
    return () => {
      grid.style.removeProperty('--article-sidenav-w');
    };
  }, [collapsed]);

  function toggle() {
    setCollapsed((c) => {
      const next = !c;
      try {
        window.localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
      } catch {
        /* ignore */
      }
      return next;
    });
  }

  return (
    <div
      ref={ref}
      className="article-read-sidenav"
      style={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        minWidth: 0,
      }}
    >
      {!collapsed && <ArticleSideNav {...props} />}
      <button
        type="button"
        onClick={toggle}
        aria-label={collapsed ? 'Expand folder navigation' : 'Collapse folder navigation'}
        title={collapsed ? 'Expand folders' : 'Collapse folders'}
        style={{
          position: 'absolute',
          top: 8,
          right: collapsed ? '50%' : 6,
          transform: collapsed ? 'translateX(50%)' : 'none',
          width: 22,
          height: 22,
          display: 'grid',
          placeItems: 'center',
          border: '1px solid var(--line)',
          borderRadius: 4,
          background: 'var(--surface)',
          color: 'var(--dim)',
          cursor: 'pointer',
          zIndex: 1,
        }}
      >
        <Icon.panelRight
          size={12}
          style={{ transform: collapsed ? 'none' : 'scaleX(-1)' }}
        />
      </button>
    </div>
  );
}
