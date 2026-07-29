import { useScopedNavigate } from '../lib/scoped-nav';
import { EmptyState } from './states';

/**
 * Not-found state for detail screens, with the cross-org escape hatch
 * (Phase 5b D4).
 *
 * Deep-link URLs carry no company id, so a cold link is resolved under
 * the device's persisted org — a record that lives in a DIFFERENT
 * accessible org therefore 404s here even though the technician could
 * read it. That narrowing is deliberate (an entity→company resolve
 * endpoint would be new cross-tenant authorization surface); the honest
 * path out is global search, which finds the record wherever the actor
 * can see it and carries its org into the destination.
 *
 * The push stamps `orgId: null` (global search) and `upIsBack` so
 * search's Done pops truthfully back to this screen.
 */
export function DeepLinkNotFound({ message }: { message: string }) {
  const navigate = useScopedNavigate();
  return (
    <EmptyState
      message={message}
      actionLabel="Search all organizations"
      onAction={() => navigate({ to: '/search', orgId: null, upIsBack: true })}
    />
  );
}
