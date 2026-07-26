import { Icon, type IconName } from '../../components/Icon';
import { Card, SectionLabel } from '../../components/primitives';
import { useScopedNavigate } from '../../lib/scoped-nav';
import type { RelatedGroups, RelatedItem } from './api';

const KIND_ICON: Record<RelatedItem['kind'], IconName> = {
  password: 'lock',
  asset: 'dns',
  article: 'description',
};

/** Detail routes that exist today. Assets arrive in Phase 2c. */
const KIND_ROUTE: Partial<Record<RelatedItem['kind'], string>> = {
  password: '/passwords',
  article: '/articles',
};

/**
 * The detail screens' Related block (1c). Password and article rows
 * navigate; asset rows are deliberately INERT until Phase 2c ships
 * their screen — a chevron that dead-ends teaches the user not to
 * trust chevrons. The affordance (chevron + press state) exists only
 * where a destination does.
 */
export function RelatedSection({ groups }: { groups: RelatedGroups }) {
  const navigate = useScopedNavigate();
  const items = [...groups.password, ...groups.asset, ...groups.article];
  if (items.length === 0) return null;

  return (
    <section className="flex flex-col gap-2.25">
      <SectionLabel>Related</SectionLabel>
      <Card>
        {items.map((item, i) => {
          const route = KIND_ROUTE[item.kind];
          const inner = (
            <>
              <Icon
                name={KIND_ICON[item.kind]}
                size={22}
                className="shrink-0 text-accent"
              />
              <span className="min-w-0 flex-1 text-left">
                <span className="block truncate text-body font-medium text-text">
                  {item.title}
                </span>
                {item.subtitle && (
                  <span className="block truncate font-mono text-[13px] text-muted">
                    {item.subtitle}
                  </span>
                )}
              </span>
              {route && (
                <Icon name="chevron_right" size={22} className="shrink-0 text-faint" />
              )}
            </>
          );
          const rowClass =
            'flex w-full items-center gap-3 px-4 py-3.5 min-h-group-row' +
            (i > 0 ? ' border-t border-line' : '');

          return route ? (
            <button
              key={item.relationId}
              type="button"
              onClick={() => navigate({ to: `${route}/${item.id}` })}
              className={rowClass + ' active:bg-panel-2'}
            >
              {inner}
            </button>
          ) : (
            <div key={item.relationId} className={rowClass}>
              {inner}
            </div>
          );
        })}
      </Card>
    </section>
  );
}
