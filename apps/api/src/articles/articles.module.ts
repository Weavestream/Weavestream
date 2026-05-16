import { Module } from '@nestjs/common';
import { ArticlesController } from './articles.controller.js';
import { ArticlesService } from './articles.service.js';
import { StarsModule } from '../stars/stars.module.js';
import { UploadsModule } from '../uploads/uploads.module.js';
import { RelationsModule } from '../relations/relations.module.js';

@Module({
  imports: [StarsModule, UploadsModule, RelationsModule],
  controllers: [ArticlesController],
  providers: [ArticlesService],
  exports: [ArticlesService],
})
export class ArticlesModule {}
