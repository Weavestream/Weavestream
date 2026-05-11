import type { Metadata, Viewport } from 'next';
import { cookies } from 'next/headers';
import { Inter_Tight, JetBrains_Mono } from 'next/font/google';
import './globals.css';
import { ToastProvider } from '../components/ui/toast';
import { ThemePreferenceWatcher } from '../components/ui/theme-preference-watcher';
import { ChatPanelProvider } from '../components/chat-panel/chat-panel-provider';
import { getSettings } from '../lib/server-api';
// `buildTerm` comes from the server-safe `./lib/term` module; re-exporting
// it through `./lib/term-context` ('use client') would tag it as a client
// function and Turbopack would then refuse the call here.
import { buildTerm } from '../lib/term';
import { TermProvider } from '../lib/term-context';
import {
  UI_COOKIE_NAME,
  parseUiCookie,
  resolveSsrTheme,
} from '../lib/ui-preferences';

export const metadata: Metadata = {
  title: 'Weavestream',
  description: 'IT documentation',
  robots: { index: false, follow: false },
  // Belt-and-suspenders: the App Router already wires icon.tsx /
  // apple-icon.tsx via convention, but declaring them here means any
  // consumer reading `metadata.icons` (e.g. a future PWA manifest)
  // sees the same source of truth.
  icons: {
    icon: '/icon',
    apple: '/apple-icon',
  },
};

// Phase 9c. Explicit mobile viewport — without this iOS Safari renders
// the page at a synthetic 980px and then downscales, which makes our
// `max-width: 767.98px` media queries never match and the hamburger +
// card layouts stay dormant. `width=device-width` pairs with
// `initial-scale=1` so layout work we do in CSS matches the physical
// viewport. `viewportFit: cover` lets the shell extend under iOS
// notches; safe-area inset padding is already handled per-surface.
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0b0d10' },
  ],
};

// Self-hosted fonts. next/font inlines the binary at build time so CSP
// `connect-src 'self'` stays strict and there are no runtime requests to
// fonts.googleapis.com / fonts.gstatic.com.
const interTight = Inter_Tight({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  display: 'swap',
  variable: '--font-sans-loaded',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  display: 'swap',
  variable: '--font-mono-loaded',
});

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Phase 9b.1: per-user appearance preferences. The API writes the
  // `ws_ui` cookie on login and on every PATCH /me/preferences, so SSR
  // has the final theme + accent without a second network hop. First-
  // time visitors (no cookie) fall back to system/lime, matching what
  // we store for fresh `User` rows.
  const cookieStore = await cookies();
  const prefs = parseUiCookie(cookieStore.get(UI_COOKIE_NAME)?.value);
  const ssrTheme = resolveSsrTheme(prefs);
  // Settings drive the workspace chip + tenant terminology ("Company"
  // vs "Client" vs "Department"). Unauthenticated routes (/login, /setup)
  // will 401 on /settings and fall back to DEFAULT_SETTINGS, which is
  // acceptable — those pages don't render the tenant term anyway.
  const settings = await getSettings();
  const term = buildTerm(settings);
  return (
    <html
      lang="en"
      data-theme={ssrTheme}
      data-accent={prefs.uiAccent}
      data-theme-pref={prefs.uiTheme}
      suppressHydrationWarning
      className={`${interTight.variable} ${jetbrainsMono.variable} h-full`}
    >
      <body className="h-full bg-bg text-fg antialiased">
        <ThemePreferenceWatcher mode={prefs.uiTheme} />
        <TermProvider term={term}>
          <ToastProvider>
            {/* Mounted at the root so the chat panel's tabs + in-flight
                streams survive cross-shell navigations (admin → company
                → portal → me). The provider only owns state; the
                visual `<ChatPanel />` is still rendered inside the
                shells that should show it. */}
            <ChatPanelProvider>{children}</ChatPanelProvider>
          </ToastProvider>
        </TermProvider>
      </body>
    </html>
  );
}
