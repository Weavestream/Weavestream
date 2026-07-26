import type { PasswordFolderSchema, PasswordSummary } from '@weavestream/shared';
import { Chip } from '../../components/primitives';
import { needsAttention } from './attention';

/** The list's filter state, carried in the route search params. */
export interface PasswordListFilter {
  folder?: string;
  view?: 'attention' | 'archived';
}

/**
 * The 2b chip row: `All {n}` · one chip per folder · the attention
 * count (bare number on a danger icon, hidden at zero — approved 2b
 * shows no word) · Archived (desktop's "Show archived" toggle,
 * re-expressed as a filter chip).
 *
 * Folders render flat in server order (`position asc, name asc`) —
 * nesting is a picker/tree concern, not a chip-row one. Counts beyond
 * "All" are deliberately absent from folder chips, matching the mock.
 */
export function PasswordFilterChips({
  items,
  folders,
  filter,
  onChange,
}: {
  /** The ACTIVE list — drives the All and attention counts. */
  items: PasswordSummary[];
  folders: PasswordFolderSchema[];
  filter: PasswordListFilter;
  onChange: (next: PasswordListFilter) => void;
}) {
  const now = Date.now();
  const attentionCount = items.filter((p) => needsAttention(p, now)).length;
  const allActive = !filter.folder && !filter.view;

  return (
    <>
      <Chip active={allActive} onClick={() => onChange({})}>
        All {items.length}
      </Chip>

      {folders.map((f) => (
        <Chip
          key={f.id}
          icon="folder"
          active={filter.folder === f.id}
          onClick={() => onChange(filter.folder === f.id ? {} : { folder: f.id })}
        >
          {f.name}
        </Chip>
      ))}

      {attentionCount > 0 && (
        <Chip
          icon="error"
          iconClassName="text-danger"
          active={filter.view === 'attention'}
          aria-label={`Needs attention: ${attentionCount}`}
          onClick={() =>
            onChange(filter.view === 'attention' ? {} : { view: 'attention' })
          }
        >
          {attentionCount}
        </Chip>
      )}

      <Chip
        active={filter.view === 'archived'}
        onClick={() =>
          onChange(filter.view === 'archived' ? {} : { view: 'archived' })
        }
      >
        Archived
      </Chip>
    </>
  );
}
