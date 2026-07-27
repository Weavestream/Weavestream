import { Module } from '@nestjs/common';
import { ArticlesController } from './articles.controller.js';
import { ArticlesService } from './articles.service.js';
import { StarsModule } from '../stars/stars.module.js';
import { UploadsModule } from '../uploads/uploads.module.js';
import { RelationsModule } from '../relations/relations.module.js';
import { AiModule } from '../ai/ai.module.js';

@Module({
  // AiModule: the Phase-4 summary lifecycle reads the auto-summaries
  // gate on article writes (AiSettingsService). QueuesService needs no
  // import — QueuesProducerModule is @Global().
  imports: [StarsModule, UploadsModule, RelationsModule, AiModule],
  controllers: [ArticlesController],
  providers: [ArticlesService],
  exports: [ArticlesService],
})
export class ArticlesModule {}
