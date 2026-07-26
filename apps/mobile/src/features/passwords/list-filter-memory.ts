import { createListFilterMemory } from '../../lib/list-filter-memory';
import type { PasswordListFilter } from './PasswordFilterChips';

/**
 * Passwords instance of the shared org-keyed list-filter memory (see
 * `lib/list-filter-memory.ts` for the invariant). Export names are
 * unchanged from the pre-factory module so call sites didn't move.
 */
const memory = createListFilterMemory<PasswordListFilter>();

export const rememberListFilter = memory.remember;
export const recallListFilter = memory.recall;
export const resetListFilterMemoryForTests = memory.resetForTests;
