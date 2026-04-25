import { Module } from '@nestjs/common';
import { ExportsController } from './exports.controller.js';
import { ExportsService } from './exports.service.js';
import { ExportDataModule } from './export-data.module.js';
import { AuditModule } from '../audit/audit.module.js';

/**
 * API-side export module. Provides the HTTP endpoints that trigger and
 * poll company PDF exports. Business logic lives in ExportsService;
 * data-gathering in CompanyExportDataService (via ExportDataModule).
 *
 * QueuesService, MinioService, and SecretEncryptionService are all
 * @Global() so they're available without an explicit import here. The
 * AuditModule is NOT global — it has to be imported anywhere we want
 * to call `audit.log()`.
 */
@Module({
  imports: [ExportDataModule, AuditModule],
  controllers: [ExportsController],
  providers: [ExportsService],
})
export class ExportsModule {}
