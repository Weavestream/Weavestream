import type { FolderNode } from '@weavestream/shared';
import { Chip } from '../../components/primitives';
import { flattenFolderTree } from './folders';

/** The list's filter state, carried in the route search params. */
export interface ArticleListFilter {
  folder?: string;
}

/**
 * The articles chip row: `All` · one chip per folder, flattened DFS
 * pre-order with breadcrumb labels ("Parent / Child") — bare names
 * repeat across parents and an ambiguous chip filters the wrong thing.
 *
 * Differences from the passwords row, all deliberate:
 *  - "All" carries no count — the list is cursor-paginated and the
 *    server sends no total, so any number would be a lie.
 *  - No Archived chip: mobile articles cut the archive view (T3). An
 *    archived runbook is an *obsolete procedure* — surfacing it onsite
 *    invites a tech to follow it. Desktop remains the archive surface.
 *  - No "Unfiled" chip in v1; the server supports `folderId=root` if
 *    one is ever wanted.
 *
 * A chip tap re-queries server-side (`folderId` param) — client-side
 * filtering can't work over partially loaded pages.
 */
export function ArticleFilterChips({
  folders,
  filter,
  onChange,
}: {
  folders: FolderNode[];
  filter: ArticleListFilter;
  onChange: (next: ArticleListFilter) => void;
}) {
  const flat = flattenFolderTree(folders);
  return (
    <>
      <Chip active={!filter.folder} onClick={() => onChange({})}>
        All
      </Chip>
      {flat.map((f) => (
        <Chip
          key={f.id}
          icon="folder"
          active={filter.folder === f.id}
          onClick={() => onChange(filter.folder === f.id ? {} : { folder: f.id })}
        >
          {f.label}
        </Chip>
      ))}
    </>
  );
}
