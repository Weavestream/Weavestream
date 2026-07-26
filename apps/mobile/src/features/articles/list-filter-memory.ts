import { createListFilterMemory } from '../../lib/list-filter-memory';
import type { ArticleListFilter } from './ArticleFilterChips';

/**
 * Articles instance of the shared org-keyed list-filter memory (see
 * `lib/list-filter-memory.ts` for the invariant).
 */
const memory = createListFilterMemory<ArticleListFilter>();

export const rememberListFilter = memory.remember;
export const recallListFilter = memory.recall;
export const resetListFilterMemoryForTests = memory.resetForTests;
