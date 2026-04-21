import { Module } from '@nestjs/common';
import { SearchController } from './search.controller.js';
import { SearchService } from './search.service.js';
import { SearchIndexService } from './search-index.service.js';
import { FieldTypesModule } from '../field-types/field-types.module.js';

/**
 * Phase 6 search module. Exports `SearchIndexService` so AssetsService
 * + AssetLayoutsService can call `upsertAsset` / `reindexLayout` from
 * their own write transactions; exports `SearchService` so the
 * Tiptap mention picker (articles / assets modules) can keep its
 * existing dependency on the mentions endpoint while the palette
 * lands on top of the same service.
 */
@Module({
  imports: [FieldTypesModule],
  controllers: [SearchController],
  providers: [SearchService, SearchIndexService],
  exports: [SearchService, SearchIndexService],
})
export class SearchModule {}
