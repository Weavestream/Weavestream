import { Module } from '@nestjs/common';
import { TagsController } from './tags.controller.js';
import { TagsService } from './tags.service.js';
import { SearchModule } from '../search/search.module.js';

@Module({
  // SearchModule: a tag rename/delete reindexes the assets that hold it.
  imports: [SearchModule],
  controllers: [TagsController],
  providers: [TagsService],
  exports: [TagsService],
})
export class TagsModule {}
