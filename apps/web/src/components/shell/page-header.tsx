import type { ReactNode } from 'react';
import { TopBar, type Crumb } from './top-bar';

export function PageHeader({
  crumbs,
  title,
  description,
  actions,
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
}) {
  const sub = (
    <>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
        <h1
          style={{
            margin: 0,
            fontFamily: 'var(--font-display)',
            fontSize: 22,
            fontWeight: 600,
            letterSpacing: -0.5,
            color: 'var(--text)',
          }}
        >
          {title}
        </h1>
        {description && (
          <div style={{ fontSize: 12.5, color: 'var(--muted)', maxWidth: 640 }}>
            {description}
          </div>
        )}
      </div>
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
      style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16, flex: 1 }}
    >
      {children}
    </div>
  );
}
