import { Icon, type IconName } from './Icon';
import { TAB_IDS, TAB_ROOTS, type TabId } from '../lib/tab-stacks';

/**
 * Bottom tab bar: Passwords · Articles · **Ask** · Assets · More.
 *
 * The centre slot is not a tab. Ask is presented modally over whichever
 * tab is showing, so it is a button with no active state and no route of
 * its own — which is also why it can be raised above the bar without the
 * layout having to reason about a fifth stack.
 */

const TABS: Record<TabId, { label: string; icon: IconName }> = {
  passwords: { label: 'Passwords', icon: 'lock' },
  articles: { label: 'Articles', icon: 'description' },
  assets: { label: 'Assets', icon: 'dns' },
  more: { label: 'More', icon: 'more_horiz' },
};

/** Slot order, with the Ask button occupying the middle. */
const LEFT: TabId[] = ['passwords', 'articles'];
const RIGHT: TabId[] = ['assets', 'more'];

function TabButton({
  tab,
  active,
  onSelect,
}: {
  tab: TabId;
  active: boolean;
  onSelect: (tab: TabId) => void;
}) {
  const { label, icon } = TABS[tab];
  return (
    <button
      type="button"
      onClick={() => onSelect(tab)}
      aria-current={active ? 'page' : undefined}
      className="flex flex-1 flex-col items-center gap-0.75 py-1.5"
    >
      {/* Icon keeps `--accent`: a 25px glyph is a graphical object, held
          to 3:1. The 11px label uses `--accent-text`, which is the same
          accent darkened enough to clear 4.5:1 as text. */}
      <Icon
        name={icon}
        size={25}
        className={active ? 'text-accent' : 'text-dim'}
      />
      <span
        className={
          'text-tab font-medium ' + (active ? 'text-accent-text' : 'text-dim')
        }
      >
        {label}
      </span>
    </button>
  );
}

export function TabBar({
  activeTab,
  onSelectTab,
  onAsk,
  showAsk = true,
}: {
  activeTab: TabId | null;
  onSelectTab: (tab: TabId) => void;
  onAsk: () => void;
  /** False for CLIENT_USER — desktop hides chat on portals; parity. */
  showAsk?: boolean;
}) {
  return (
    <nav
      aria-label="Main"
      className="z-tabbar flex shrink-0 items-end border-t border-line bg-bg px-1.5 pb-edge-b pt-2"
    >
      {LEFT.map((tab) => (
        <TabButton
          key={tab}
          tab={tab}
          active={activeTab === tab}
          onSelect={onSelectTab}
        />
      ))}

      {/* Fixed 84px so the four real tabs stay evenly sized regardless of
          the raised button, per the handoff's slot spec. The slot keeps
          its width even with Ask hidden, so the tabs don't shift between
          roles. */}
      <div className="flex shrink-0 basis-[84px] justify-center">
        {showAsk && (
          <button
            type="button"
            onClick={onAsk}
            aria-label="Ask anything"
            className={
              'mb-3.5 flex h-ask w-ask items-center justify-center rounded-ask ' +
              'bg-accent-fill text-accent-fill-ink shadow-ask active:bg-accent-pressed'
            }
          >
            <Icon name="auto_awesome" size={29} />
          </button>
        )}
      </div>

      {RIGHT.map((tab) => (
        <TabButton
          key={tab}
          tab={tab}
          active={activeTab === tab}
          onSelect={onSelectTab}
        />
      ))}
    </nav>
  );
}

export { TAB_IDS, TAB_ROOTS };
