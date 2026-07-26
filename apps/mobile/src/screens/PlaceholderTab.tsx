import { ScreenHeader } from '../components/ScreenHeader';
import { Screen } from '../components/primitives';
import {
  EmptyState,
  ErrorBanner,
  SkeletonList,
  OfflineBanner,
} from '../components/states';
import { useOnline } from '../lib/use-online';
import { useOrgScope } from '../lib/org-scope';
import { useOpenOrgSheet } from './TabShell';

/**
 * The frame for Passwords / Articles / Assets before Phase 2 fills them.
 *
 * Not a stub for its own sake: it renders the real header (org tile, org
 * name, switcher trigger, screen title) and the real scope states, which
 * is what Phase 1 exists to prove end to end. What it does not do is
 * invent content — each tab says plainly that its records arrive with
 * Phase 2 rather than showing a fake list.
 */
export function PlaceholderTab({
  title,
  note,
}: {
  title: string;
  note: string;
}) {
  const { currentOrg, scopeStatus, retry } = useOrgScope();
  const openOrgSheet = useOpenOrgSheet();
  const online = useOnline();

  return (
    <>
      <ScreenHeader
        org={currentOrg}
        onOpenOrgSheet={openOrgSheet}
        title={title}
      />
      <Screen>
        {!online && <OfflineBanner />}

        {scopeStatus === 'resolving' && <SkeletonList rows={5} />}

        {scopeStatus === 'error' && (
          <ErrorBanner
            title="Couldn’t load your organizations."
            detail="Check your connection and try again."
            onRetry={retry}
          />
        )}

        {scopeStatus === 'ready' && !currentOrg && (
          <EmptyState message="No organizations available. Ask an administrator to give you access to a client." />
        )}

        {scopeStatus === 'ready' && currentOrg && (
          <EmptyState message={note} />
        )}
      </Screen>
    </>
  );
}
