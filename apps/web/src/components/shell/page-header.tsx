import type { ReactNode } from 'react';
import { TopBar, type Crumb } from './top-bar';

export function PageHeader({
  crumbs,
  title,
  description,
  actions,
  leading,
}: {
  crumbs: Crumb[];
  // Widened to ReactNode so pages can compose the title with an
  // inline layout swatch, badge, or other decoration while still
  // rendering inside the `<h1>` block.
  title: ReactNode;
  // Widened to ReactNode so callers can compose the subtitle area with
  // inline chips, status badges, or links (e.g. the company detail
  // page renders a type tag + parent company chip here).
  description?: ReactNode;
  actions?: ReactNode;
  // Optional left-side decoration (icon, swatch, avatar) that spans
  // the full height of the title + description block. Use when an
  // inline element next to the title alone would leave the
  // description visually unanchored.
  leading?: ReactNode;
}) {
  const titleBlock = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
      <h1
        style={{
          margin: 0,
          fontFamily: 'var(--font-display)',
          fontSize: 22,
          lineHeight: 1.2,
          fontWeight: 600,
          letterSpacing: -0.5,
          color: 'var(--text)',
        }}
      >
        {title}
      </h1>
      {description && (
        <div
          style={{
            fontSize: 12.5,
            lineHeight: 1.4,
            color: 'var(--muted)',
            maxWidth: 640,
          }}
        >
          {description}
        </div>
      )}
    </div>
  );
  const sub = (
    <>
      {leading ? (
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
            {leading}
          </div>
          {titleBlock}
        </div>
      ) : (
        titleBlock
      )}
      {actions && (
        <div
          className="page-header-actions"
          style={{ display: 'flex', gap: 8 }}
        >
          {actions}
        </div>
      )}
    </>
  );
  return <TopBar crumbs={crumbs} sub={sub} subClassName="page-header-sub" />;
}

export function PageBody({ children }: { children: ReactNode }) {
  return (
    <div
      className="page-body-tight"
      style={{
        // Extra top inset: the sticky header ends in a hard 1px rule,
        // and content starting at the same 20px it uses on the sides
        // reads as crowded against it.
        padding: '30px 20px 20px',
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        flex: 1,
        // `min-height: 0` is what unlocks `flex: 1` for actually
        // *constraining* a child's height (rather than just suggesting
        // a starting size). Required so a child Panel with
        // `fillHeight` can claim the remaining viewport and let its
        // contents (typically a DataTable) scroll internally instead
        // of pushing the whole page down. Safe for non-fillHeight
        // pages — they continue to grow naturally.
        minHeight: 0,
      }}
    >
      {children}
    </div>
  );
}
