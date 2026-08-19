import { Module } from '@nestjs/common';
import { RecentCompaniesController } from './recent-companies.controller.js';
import { RecentCompaniesService } from './recent-companies.service.js';

// `PrismaModule` and `RedisModule` are global — no imports needed.
@Module({
  controllers: [RecentCompaniesController],
  providers: [RecentCompaniesService],
})
export class RecentCompaniesModule {}
