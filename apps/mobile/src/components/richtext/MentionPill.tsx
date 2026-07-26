import { Icon, type IconName } from '../Icon';
import { str } from './attr';

const KIND_ICON: Record<string, IconName> = {
  password: 'lock',
  asset: 'dns',
  article: 'description',
};

/**
 * Inline `@mention` of an asset/article/password inside prose. Also
 * renders the legacy `internalLink` node, which predates `mention` and
 * carries `title` where mention carries `label`.
 *
 * **Deliberately inert in v1.** A navigable pill inline in prose cannot
 * meet the 44pt tap-target rule (CLAUDE.md) at prose line-height, and
 * shrinking the rule for it would make the one sub-44pt tappable thing
 * on the screen the one embedded in a wall of text. The Related section
 * below the body provides full-height navigable rows to the same
 * records. Revisit only with a design that solves the hit target
 * honestly (e.g. tap opens a preview sheet anchored to a 44pt zone).
 */
export function MentionPill({ attrs }: { attrs: Record<string, unknown> | undefined }) {
  const kindRaw = str(attrs?.kind);
  const kind = kindRaw !== null && kindRaw in KIND_ICON ? kindRaw : 'article';
  // Object-valued labels must render as the fallback, never reach JSX
  // (React throws on object children).
  const label = str(attrs?.label) ?? str(attrs?.title) ?? '—';
  return (
    <span className="m-mention">
      <Icon name={KIND_ICON[kind]!} size={14} className="shrink-0" />
      {label}
    </span>
  );
}
