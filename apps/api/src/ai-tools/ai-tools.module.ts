import { Module } from '@nestjs/common';
import { RbacModule } from '../rbac/rbac.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { SearchModule } from '../search/search.module.js';
import { RelationsModule } from '../relations/relations.module.js';
import { ArticlesModule } from '../articles/articles.module.js';
import { EntityScopeService } from './entity-scope.js';
import { AiToolBudgetService } from './ai-tool-budget.service.js';
import { AiToolExecutorService } from './ai-tool-executor.service.js';
import { AiToolRegistry } from './tool-registry.js';
import { SearchAiTool } from './tools/search.tool.js';
import { GetArticleAiTool } from './tools/get-article.tool.js';
import { GetRelatedItemsAiTool } from './tools/get-related-items.tool.js';
import { FindRelatedItemsAiTool } from './tools/find-related-items.tool.js';
import { GetCompanySummaryAiTool } from './tools/get-company-summary.tool.js';
import { GetAppHelpAiTool } from './tools/get-app-help.tool.js';
import { AppHelpService } from '../ai-help/app-help.service.js';

/**
 * WS-030 — typed AI tool registry. Read tools execute server-side in
 * the chat streaming loop behind the acting user's own permissions;
 * proposal tools (update/create article) still only produce pending
 * Apply/Reject cards. Nest has no multi-provider concept, so the
 * registry is wired with an explicit factory — its constructor
 * enforces at boot that every read-mode spec has an implementation.
 */
@Module({
  // Prisma / Redis / Config are @Global — only feature modules listed.
  imports: [RbacModule, AuditModule, SearchModule, RelationsModule, ArticlesModule],
  providers: [
    EntityScopeService,
    AiToolBudgetService,
    AppHelpService,
    SearchAiTool,
    GetArticleAiTool,
    GetRelatedItemsAiTool,
    FindRelatedItemsAiTool,
    GetCompanySummaryAiTool,
    GetAppHelpAiTool,
    {
      provide: AiToolRegistry,
      useFactory: (
        search: SearchAiTool,
        getArticle: GetArticleAiTool,
        getRelatedItems: GetRelatedItemsAiTool,
        findRelatedItems: FindRelatedItemsAiTool,
        getCompanySummary: GetCompanySummaryAiTool,
        getAppHelp: GetAppHelpAiTool,
      ) =>
        new AiToolRegistry([
          search,
          getArticle,
          getRelatedItems,
          findRelatedItems,
          getCompanySummary,
          getAppHelp,
        ]),
      inject: [
        SearchAiTool,
        GetArticleAiTool,
        GetRelatedItemsAiTool,
        FindRelatedItemsAiTool,
        GetCompanySummaryAiTool,
        GetAppHelpAiTool,
      ],
    },
    AiToolExecutorService,
  ],
  exports: [AiToolRegistry, AiToolExecutorService, AiToolBudgetService, EntityScopeService],
})
export class AiToolsModule {}
