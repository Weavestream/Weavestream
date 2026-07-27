import { useEffect } from 'react';
import { FormScreenChrome } from '../../components/FormScreenChrome';
import { ListRow } from '../../components/primitives';
import { EmptyState, ErrorBanner, SkeletonList } from '../../components/states';
import { useBackOr } from '../../lib/use-back';
import { useOrgScope } from '../../lib/org-scope';
import { useScopedNavigate } from '../../lib/scoped-nav';
import { useCompanyAccess } from '../../lib/use-company-access';
import { LayoutTile } from './LayoutTile';
import { recallListFilter } from './list-filter-memory';
import { unsatisfiableRequiredFields } from './field-values';
import { useLayouts } from './queries';

/**
 * Step 1 of creating an asset: pick the layout (`/assets/new` with no
 * `?layout`). Choosing one REPLACES this entry with the form, so the
 * whole create flow occupies ONE stack slot above the list — the same
 * shape as the passwords form. That is load-bearing for the new
 * detail's "‹ Assets" chevron: `upIsBack` survives replaces (the
 * stamp inherits from this entry, which the list pushed), and popping
 * from the created detail must land on the LIST, not back on this
 * chooser. A push here was the original 2c bug: create → detail →
 * "‹ Assets" returned to the create flow. A cold deep link to the
 * chooser carries no stamp, so everything downstream falls back to
 * structural navigation. Deep links with `?layout=` skip the chooser
 * entirely (desktop parity).
 *
 * Layouts with required fields mobile can't edit (RICH_TEXT etc. — the
 * API enforces required on every field at create) are still tappable
 * but carry a "Requires desktop" note; the form screen explains and
 * blocks, so the explanation lives in one place.
 */
export function LayoutChooserScreen() {
  const { currentOrg, scopeStatus } = useOrgScope();
  const { canWrite, isClientUser } = useCompanyAccess();
  const canManage = canWrite && !isClientUser;
  const navigate = useScopedNavigate();
  const layoutsQuery = useLayouts();

  const orgId = currentOrg?.id ?? null;
  const cancel = useBackOr('/assets', recallListFilter(orgId));

  // Deep-linked or role-changed viewers without write access bounce
  // straight back — the server would 403 the create anyway.
  useEffect(() => {
    if (scopeStatus === 'ready' && !canManage) {
      navigate({ to: '/assets', replace: true });
    }
  }, [scopeStatus, canManage, navigate]);

  const layouts = (layoutsQuery.data ?? []).filter(
    (l) => l.isActive && l.archivedAt === null,
  );

  return (
    <FormScreenChrome title="New asset" onCancel={cancel}>
      {(scopeStatus !== 'ready' || !currentOrg || !canManage || layoutsQuery.isPending) && (
        <SkeletonList rows={4} variant="row" />
      )}

      {scopeStatus === 'ready' && currentOrg && canManage && layoutsQuery.error != null && (
        <ErrorBanner
          title="Couldn’t load layouts."
          detail="Check your connection and try again."
          onRetry={() => void layoutsQuery.refetch()}
        />
      )}

      {scopeStatus === 'ready' &&
        currentOrg &&
        canManage &&
        layoutsQuery.data &&
        (layouts.length === 0 ? (
          <EmptyState message="No layouts available. Layouts are managed on desktop." />
        ) : (
          <div className="flex flex-col gap-2">
            <p className="text-meta text-muted">Pick a layout for the new asset.</p>
            {layouts.map((l) => {
              const desktopOnly = unsatisfiableRequiredFields(l.fields).length > 0;
              const fieldCount = l.fields.filter((f) => f.archivedAt === null).length;
              return (
                <ListRow
                  key={l.id}
                  title={l.name}
                  metaFont="sans"
                  meta={
                    `${fieldCount} field${fieldCount === 1 ? '' : 's'}` +
                    (desktopOnly ? ' · Requires desktop' : '')
                  }
                  minHeight="row"
                  leading={<LayoutTile icon={l.icon} color={l.color} />}
                  // Replace, no explicit upIsBack: the stamp INHERITS
                  // from this entry (present iff the list pushed us) —
                  // stamping unconditionally would let a cold deep link
                  // claim "parent is one behind" toward a stranger.
                  onClick={() =>
                    navigate({ to: '/assets/new', search: { layout: l.id }, replace: true })
                  }
                />
              );
            })}
          </div>
        ))}
    </FormScreenChrome>
  );
}
