import { Module } from '@nestjs/common';
import { IntegrationsService } from './integrations.service.js';
import { IntegrationCompanyMappingService } from './company-mapping.service.js';
import { IntegrationSyncService } from './integration-sync.service.js';
import { IntegrationSyncRunnerService } from './integration-sync-runner.service.js';
import { MatchResolverService } from './match-resolver.service.js';
import { IntegrationDriverRegistry } from './drivers/integration-driver.registry.js';
import { IntegrationSyncSchedulerService } from './integration-sync-scheduler.service.js';
import { CloudflareListsService } from './cloudflare/cloudflare-lists.service.js';
import { TicketsService } from './tickets.service.js';
import { FieldTypesModule } from '../field-types/field-types.module.js';
import { SearchModule } from '../search/search.module.js';
import { QueuesProducerModule } from '../queues/queues-producer.module.js';
import { AssetsModule } from '../assets/assets.module.js';
import { IpamModule } from '../ipam/ipam.module.js';
import { ArticlesModule } from '../articles/articles.module.js';
import { RelationsModule } from '../relations/relations.module.js';
import { IntegrationTransformService } from './transforms/integration-transform.service.js';
import { ReconstructionWriterRegistry } from './reconstruction/reconstruction-writer.registry.js';
import { AssetTargetWriter } from './reconstruction/asset-target.writer.js';
import {
  IpReservationTargetWriter,
  SubnetTargetWriter,
} from './reconstruction/ipam-target.writer.js';
import { ArticleTargetWriter } from './reconstruction/article-target.writer.js';
import { RelationTargetWriter } from './reconstruction/relation-target.writer.js';
import type {
  ReconstructionInput,
  ReconstructionWriter,
} from './reconstruction/reconstruction-target.js';
import { IntegrationProvenanceService } from './reconstruction/integration-provenance.service.js';
import { IntegrationCompletenessService } from './reconstruction/integration-completeness.service.js';
import { AssetsService } from '../assets/assets.service.js';
import { IpamService } from '../ipam/ipam.service.js';
import { ArticlesService } from '../articles/articles.service.js';
import { RelationsService } from '../relations/relations.service.js';

/**
 * Phase 11 — shared integration services.
 *
 * Imported by both the API (`IntegrationsModule`, which adds the
 * controller + cron registrar) and the worker (which only needs the
 * services to drive the BullMQ processors). Splitting the module this
 * way keeps the worker free of the controller / registrar — the
 * registrar must only run on the API side so the cron registrations
 * are owned in exactly one place.
 */
@Module({
  imports: [
    FieldTypesModule,
    SearchModule,
    QueuesProducerModule,
    AssetsModule,
    IpamModule,
    ArticlesModule,
    RelationsModule,
  ],
  providers: [
    IntegrationDriverRegistry,
    IntegrationTransformService,
    {
      provide: AssetTargetWriter,
      inject: [AssetsService],
      useFactory: (assets: AssetsService) => new AssetTargetWriter(assets),
    },
    {
      provide: SubnetTargetWriter,
      inject: [IpamService],
      useFactory: (ipam: IpamService) => new SubnetTargetWriter(ipam),
    },
    {
      provide: IpReservationTargetWriter,
      inject: [IpamService],
      useFactory: (ipam: IpamService) => new IpReservationTargetWriter(ipam),
    },
    {
      provide: ArticleTargetWriter,
      inject: [ArticlesService],
      useFactory: (articles: ArticlesService) => new ArticleTargetWriter(articles),
    },
    {
      provide: RelationTargetWriter,
      inject: [RelationsService],
      useFactory: (relations: RelationsService) => new RelationTargetWriter(relations),
    },
    {
      provide: ReconstructionWriterRegistry,
      inject: [
        AssetTargetWriter,
        SubnetTargetWriter,
        IpReservationTargetWriter,
        ArticleTargetWriter,
        RelationTargetWriter,
      ],
      useFactory: (
        asset: AssetTargetWriter,
        subnet: SubnetTargetWriter,
        reservation: IpReservationTargetWriter,
        article: ArticleTargetWriter,
        relation: RelationTargetWriter,
      ) => new ReconstructionWriterRegistry([
        asset,
        subnet,
        reservation,
        article,
        relation,
      ] as ReconstructionWriter<ReconstructionInput>[]),
    },
    IntegrationsService,
    IntegrationCompanyMappingService,
    IntegrationSyncService,
    IntegrationProvenanceService,
    IntegrationCompletenessService,
    IntegrationSyncRunnerService,
    IntegrationSyncSchedulerService,
    MatchResolverService,
    CloudflareListsService,
    TicketsService,
  ],
  exports: [
    IntegrationDriverRegistry,
    IntegrationTransformService,
    ReconstructionWriterRegistry,
    IntegrationsService,
    IntegrationCompanyMappingService,
    IntegrationSyncService,
    IntegrationProvenanceService,
    IntegrationCompletenessService,
    IntegrationSyncRunnerService,
    IntegrationSyncSchedulerService,
    MatchResolverService,
    CloudflareListsService,
    TicketsService,
  ],
})
export class IntegrationsCoreModule {}
