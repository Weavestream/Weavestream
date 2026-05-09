import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { z } from 'zod';
import { searchQuerySchema, type SearchResponse } from '@weavestream/shared';
import { SearchService, type MentionKind } from './search.service.js';
import { CurrentUser, type AuthedUser } from '../common/current-user.decorator.js';
import { AuthedOnly } from '../rbac/require-permission.decorator.js';

/**
 * Query-string coercion layer. Browsers send everything as strings,
 * so we run the raw `?q=&companyId=&types=asset,article&…` params
 * through this schema first, then into `searchQuerySchema` which
 * owns the *semantic* bounds (max length, enum values, min 1).
 *
 * Keeping the coercion here (instead of in shared) means the shared
 * schema stays an honest contract consumed by the web client,
 * which already has typed booleans/arrays at call time.
 */
const searchQueryInputSchema = z.object({
  q: z.string(),
  companyId: z.string().optional(),
  types: z
    .string()
    .optional()
    .transform((v) =>
      v
        ? v
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined,
    ),
  comprehensive: z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  includeArchived: z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  limit: z
    .string()
    .optional()
    .transform((v) => (v ? Number.parseInt(v, 10) : undefined)),
  offset: z
    .string()
    .optional()
    .transform((v) => (v ? Number.parseInt(v, 10) : undefined)),
});

/**
 * `/search` is the Phase 6 palette endpoint. `/search/mentions`
 * remains for the Tiptap editor. Both are `@AuthedOnly()` because
 * the service filters to `allowedCompanyIds` internally — any extra
 * role gate here would be redundant and would risk divergence.
 */
@Controller({ path: 'search', version: '1' })
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Get()
  @AuthedOnly()
  async query(
    @CurrentUser() actor: AuthedUser,
    @Query() raw: Record<string, unknown>,
  ): Promise<SearchResponse> {
    const coerced = searchQueryInputSchema.safeParse(raw);
    if (!coerced.success) {
      throw new BadRequestException({
        error: 'ValidationError',
        issues: coerced.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
    }

    const parsed = searchQuerySchema.safeParse(coerced.data);
    if (!parsed.success) {
      throw new BadRequestException({
        error: 'ValidationError',
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
    }

    const result = await this.search.search(actor, parsed.data);
    return {
      items: result.items,
      total: result.total,
      comprehensive: result.comprehensive,
      includeArchived: result.includeArchived,
      companyId: result.companyId,
    };
  }

  @Get('mentions')
  @AuthedOnly()
  async mentions(
    @CurrentUser() actor: AuthedUser,
    @Query('q') q: string = '',
    @Query('companyId') companyId?: string,
    @Query('kinds') rawKinds?: string,
    @Query('limit') rawLimit?: string,
  ) {
    const kinds = (rawKinds?.split(',').filter(Boolean) as MentionKind[] | undefined)?.filter(
      (k): k is MentionKind => k === 'asset' || k === 'article' || k === 'password',
    );
    const results = await this.search.mentions(actor, q, {
      companyId,
      kinds,
      limit: rawLimit ? parseInt(rawLimit, 10) : undefined,
    });
    return { items: results };
  }
}
