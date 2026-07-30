import { useState } from 'react';
import { AppearanceSheet } from '../../components/AppearanceSheet';
import { DetailHeader } from '../../components/DetailHeader';
import { IdentityCard } from '../../components/IdentityCard';
import { GroupedList, GroupedRow, Title } from '../../components/primitives';
import { useScopedNavigate } from '../../lib/scoped-nav';
import { useMe } from '../../screens/TabShell';

/**
 * The account surface (Phase 5c).
 *
 * Deliberately small. Identity is **context, not a form** — name and email
 * are here so a technician knows which account they are about to act on,
 * and neither is editable: email has no change path anywhere in the product
 * (not self-service, not admin), and a name field alone did not earn a
 * screen. Timezone stays desktop-only because mobile formats in the device
 * zone on purpose (see `lib/timezone.ts`), so an editor here would write a
 * preference this app then ignores.
 *
 * Appearance lives here rather than under More's "App" group: accent and
 * theme are account state that syncs across every browser you sign in on,
 * so they belong with the account. The sheet itself is untouched — one
 * implementation, one home.
 *
 * MFA is absent by decision, not oversight: it is being revisited as one
 * coordinated desktop + mobile change.
 */
export function ProfileScreen() {
  const me = useMe();
  const navigate = useScopedNavigate();
  const [appearanceOpen, setAppearanceOpen] = useState(false);

  const name = me?.name?.trim() || me?.email || 'Signed in';

  return (
    <>
      <DetailHeader backLabel="More" backTo="/more" />
      {/* Not the shared `Screen`: that deliberately omits the bottom
          safe-area inset because a tab bar normally sits below and carries
          it — and `hideTabBarFor` blanks the bar on this path, so the last
          row would tuck under the home indicator. Same reason (and same
          shape) as SearchScreen, the other tab-bar-less routed screen. */}
      <main className="mx-auto flex min-h-0 w-full max-w-page flex-1 flex-col gap-4 overflow-y-auto px-4 pb-edge-b">
        <Title>Profile</Title>

        {/* No `onClick` — inert context on this screen (the card is the
            tappable way IN, from More). */}
        <IdentityCard name={name} email={me?.email} userRole={me?.role} />

        <GroupedList>
          <GroupedRow
            icon="palette"
            label="Appearance"
            onClick={() => setAppearanceOpen(true)}
          />
          <GroupedRow
            icon="lock"
            label="Change password"
            onClick={() =>
              navigate({
                to: '/profile/password',
                upIsBack: true,
                backLabel: 'Profile',
              })
            }
            last
          />
        </GroupedList>
      </main>

      <AppearanceSheet
        open={appearanceOpen}
        onClose={() => setAppearanceOpen(false)}
      />
    </>
  );
}
