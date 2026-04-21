import { Module } from '@nestjs/common';
import { AssetLayoutsController } from './asset-layouts.controller.js';
import { AssetLayoutsService } from './asset-layouts.service.js';
import { FieldTypesModule } from '../field-types/field-types.module.js';
import { SearchModule } from '../search/search.module.js';

@Module({
  imports: [FieldTypesModule, SearchModule],
  controllers: [AssetLayoutsController],
  providers: [AssetLayoutsService],
  exports: [AssetLayoutsService],
})
export class AssetLayoutsModule {}
