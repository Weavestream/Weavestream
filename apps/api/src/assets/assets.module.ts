import { Module } from '@nestjs/common';
import { AssetsController } from './assets.controller.js';
import { AssetsService } from './assets.service.js';
import { FieldTypesModule } from '../field-types/field-types.module.js';
import { RelationsModule } from '../relations/relations.module.js';
import { UploadsModule } from '../uploads/uploads.module.js';
import { SearchModule } from '../search/search.module.js';
import { PasswordsModule } from '../passwords/passwords.module.js';
import { StarsModule } from '../stars/stars.module.js';
import { TagsModule } from '../tags/tags.module.js';

@Module({
  imports: [
    FieldTypesModule,
    RelationsModule,
    UploadsModule,
    SearchModule,
    PasswordsModule,
    StarsModule,
    TagsModule,
  ],
  controllers: [AssetsController],
  providers: [AssetsService],
  exports: [AssetsService],
})
export class AssetsModule {}
