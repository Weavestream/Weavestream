import { Global, Module } from '@nestjs/common';
import { FieldTypesRegistry } from './field-types.registry.js';

@Global()
@Module({
  providers: [FieldTypesRegistry],
  exports: [FieldTypesRegistry],
})
export class FieldTypesModule {}
