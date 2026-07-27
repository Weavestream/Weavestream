import { createListFilterMemory } from '../../lib/list-filter-memory';
import type { AssetListFilter } from './AssetFilterChips';

/**
 * Assets instance of the shared org-keyed list-filter memory (see
 * `lib/list-filter-memory.ts` for the invariant).
 */
const memory = createListFilterMemory<AssetListFilter>();

export const rememberListFilter = memory.remember;
export const recallListFilter = memory.recall;
export const resetListFilterMemoryForTests = memory.resetForTests;
