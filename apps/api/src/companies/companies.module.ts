import { Module } from '@nestjs/common';
import { CompaniesController } from './companies.controller.js';
import { CompaniesService } from './companies.service.js';

@Module({
  controllers: [CompaniesController],
  providers: [CompaniesService],
  exports: [CompaniesService],
})
export class CompaniesModule {}
