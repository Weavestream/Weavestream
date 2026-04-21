import type { ReactNode } from 'react';
import { AppLogo, ThemeToggle } from '../ui';

export function AuthShell({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <main
      className="auth-shell-main"
      style={{
        minHeight: '100dvh',
        display: 'grid',
        placeItems: 'center',
        padding: 24,
        background: 'var(--bg)',
        position: 'relative',
      }}
    >
      {/*
        Phase 9b.1: a theme flip on the login/setup shell. Unauthenticated
        so it falls back to the public `POST /public/ui-prefs` endpoint,
        which only writes the `ws_ui` cookie — no session required.
      */}
      <div style={{ position: 'absolute', top: 20, right: 20 }}>
        <ThemeToggle authenticated={false} />
      </div>
      <div
        className="auth-shell-card"
        style={{
          width: '100%',
          maxWidth: 380,
          background: 'var(--panel)',
          border: '1px solid var(--line)',
          borderRadius: 8,
          padding: 28,
          boxShadow: 'var(--shadow-2)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 18 }}>
          <AppLogo size={22} />
        </div>
        <h1
          style={{
            margin: 0,
            fontFamily: 'var(--font-display)',
            fontSize: 20,
            fontWeight: 600,
            letterSpacing: -0.4,
            textAlign: 'center',
            color: 'var(--text)',
          }}
        >
          {title}
        </h1>
        {subtitle && (
          <p
            style={{
              margin: '8px 0 22px',
              fontSize: 13,
              color: 'var(--muted)',
              textAlign: 'center',
              lineHeight: 1.5,
            }}
          >
            {subtitle}
          </p>
        )}
        {!subtitle && <div style={{ height: 22 }} />}
        {children}
        {footer && (
          <div
            style={{
              marginTop: 18,
              paddingTop: 16,
              borderTop: '1px solid var(--line)',
              fontSize: 11.5,
              color: 'var(--dim)',
              textAlign: 'center',
              fontFamily: 'var(--font-mono)',
            }}
          >
            {footer}
          </div>
        )}
      </div>
    </main>
  );
}
