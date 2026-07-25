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
        // No bottom inset here on purpose — `min-height: 0` below lets
        // this box be shrunk under its own content, and padding the
        // content has already spilled past buys nothing. The trailing
        // inset is the spacer element at the end of this list instead.
        padding: '20px 20px 0',
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
      {/*
        Trailing inset under the last card/table.

        This cannot be `padding-bottom` on the box above. `PageBody` is
        `flex: 1; min-height: 0` inside the scrolling `main` — that is
        what lets a `fillHeight` Panel be constrained to the viewport
        instead of growing the page — but it also lets the box be shrunk
        *below* its own content. On a page taller than the viewport the
        content spills straight past the box, and bottom padding is
        painted inside the shrunken box, above the spill. The scrollable
        overflow region ends at the last child's border box, so the last
        panel sits flush on the bottom edge with nothing under it.

        A real trailing element *is* a descendant border box, so it
        survives the spill. It carries its size inline rather than in a
        stylesheet rule on purpose: an earlier `::after` version of this
        never generated a box in Safari, and inline geometry ships with
        the server-rendered markup instead of depending on a separate
        stylesheet resolving the pseudo-element the same way.

        `marginTop` cancels the flex `gap` so the result is exactly the
        page inset and not inset + gap, which also keeps `fillHeight`
        pages at the geometry they had when padding still worked.
      */}
      <div
        aria-hidden
        style={{ height: 20, flex: '0 0 auto', marginTop: -16 }}
      />
    </div>
  );
}
