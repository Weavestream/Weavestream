import type { PasswordFolderRow } from './server-api';

export type PasswordFolderOption = {
  id: string;
  name: string;
  depth: number;
};

/**
 * Flatten the password folder list into a depth-tagged, parent-first
 * order so a single `<select>` can show the hierarchy with indentation.
 * Optionally excludes a folder and its descendants (used by the "Move
 * folder" picker, where a folder can't become its own ancestor).
 */
export function buildPasswordFolderOptions(
  folders: PasswordFolderRow[],
  excludeId?: string,
): PasswordFolderOption[] {
  const active = folders.filter((f) => !f.archivedAt);
  const byParent = new Map<string | null, PasswordFolderRow[]>();
  for (const f of active) {
    const list = byParent.get(f.parentId) ?? [];
    list.push(f);
    byParent.set(f.parentId, list);
  }
  for (const list of byParent.values()) {
    list.sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
  }
  const out: PasswordFolderOption[] = [];
  const walk = (parentId: string | null, depth: number, skip: boolean) => {
    const list = byParent.get(parentId) ?? [];
    for (const node of list) {
      const dropSubtree = skip || node.id === excludeId;
      if (!dropSubtree) {
        out.push({ id: node.id, name: node.name, depth });
      }
      walk(node.id, depth + 1, dropSubtree);
    }
  };
  walk(null, 0, false);
  return out;
}

/**
 * Render the option label with leading non-breaking spaces so the
 * indentation survives inside `<option>` (browsers collapse regular
 * whitespace there). Two NBSP per depth level keeps it compact.
 */
export function formatFolderOptionLabel(opt: PasswordFolderOption): string {
  if (opt.depth === 0) return opt.name;
  return `${'\u00A0\u00A0'.repeat(opt.depth)}↳ ${opt.name}`;
}
