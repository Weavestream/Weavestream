import type { ReactNode } from 'react';
import { AppLogo } from './AppLogo';

/**
 * Shared frame for the three unauthenticated screens (login, MFA
 * challenge, MFA setup hand-off): the Weavestream lockup, then the
 * screen's own content.
 *
 * Its own component rather than a prop on `Screen` because these screens
 * are outside the tab shell — no tab bar, no org header — and they are
 * vertically centred rather than top-aligned, which is what makes a short
 * form look deliberate on a tall phone.
 */
export function AuthScreen({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-col overflow-y-auto px-4 pb-edge-b pt-safe-t">
      <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-8 py-10">
        <div className="flex justify-center">
          <AppLogo height={28} />
        </div>
        {children}
      </div>
    </main>
  );
}
