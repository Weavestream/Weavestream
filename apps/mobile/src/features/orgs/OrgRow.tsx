import { Icon } from '../../components/Icon';
import { Avatar, ListRow } from '../../components/primitives';
import type { Org } from '../../lib/org-scope';

/**
 * One organization row — shared by the OrgSheet switcher and the
 * launcher (moved verbatim from OrgSheet in Phase 5b). `current` never
 * applies on the launcher (no org in context there), so the sheet's
 * current-org affordances simply don't render.
 */
export function OrgRow({
  org,
  current,
  onSelect,
}: {
  org: Org;
  current: boolean;
  onSelect: (org: Org) => void;
}) {
  return (
    <ListRow
      minHeight="row"
      metaFont="sans"
      selected={current}
      title={org.name}
      meta={current ? 'Current organization' : org.subtitle}
      leading={
        <Avatar
          initials={org.initials}
          size={44}
          tone={current ? 'accent' : 'neutral'}
        />
      }
      trailing={
        current ? (
          <Icon
            name="check_circle"
            size={24}
            className="text-accent"
            label="Current organization"
          />
        ) : (
          <Icon name="chevron_right" size={22} className="text-faint" />
        )
      }
      onClick={current ? undefined : () => onSelect(org)}
    />
  );
}
