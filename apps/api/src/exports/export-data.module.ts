import { Module } from '@nestjs/common';
import { CompanyExportDataService } from './company-export-data.service.js';

/**
 * Provides CompanyExportDataService — gathers all company data for a PDF
 * export. Imported by ExportsModule (API) and WorkerModule (worker) so
 * the data-gathering logic stays in one place.
 *
 * Does NOT import QueuesModule so the worker can safely import this
 * without triggering DomainChecksQueueRegistrar (which would register a
 * duplicate cron job).
 *
 * PrismaService and SecretEncryptionService are both @Global() and
 * injected automatically; no explicit imports needed here.
 */
@Module({
  providers: [CompanyExportDataService],
  exports: [CompanyExportDataService],
})
export class ExportDataModule {}
