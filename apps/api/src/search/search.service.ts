import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { requireTenantContext } from '@weavestream/shared/server';
import {
  searchEntityKinds,
  type SearchEntityKind,
  type SearchHit,
} from '@weavestream/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AuthedUser } from '../common/current-user.decorator.js';

export type MentionKind = 'asset' | 'article' | 'password';

export interface MentionResult {
  kind: MentionKind;
  id: string;
  title: string;
  companyId: string;
  companyName: string;
  folderId?: string | null;
  slug?: string | null;
  layoutIcon?: string | null;
  layoutColor?: string | null;
  layoutName?: string | null;
  updatedAt: Date;
}

export interface SearchRequest {
  q: string;
  companyId?: string;
  types?: SearchEntityKind[];
  comprehensive?: boolean;
  includeArchived?: boolean;
  limit?: number;
  offset?: number;
}

export interface SearchRunResult {
  items: SearchHit[];
  total: number | null;
  companyId: string | null;
  comprehensive: boolean;
  includeArchived: boolean;
}

/**
 * Raw-SQL row shape we get back from the tsvector query. Snippet
 * contains `<mark>…</mark>` wrappers because we hand `ts_headline`
 * `StartSel=<mark>, StopSel=</mark>`; the client renders through a
 * sanitiser that allows only `<mark>`.
 */
interface SearchIndexRow {
  entity_type: SearchEntityKind;
  entity_id: string;
  company_id: string;
  title: string;
  snippet: string;
  layout_id: string | null;
  archived_at: Date | null;
  updated_at: Date;
  score: number;
}

/**
 * Phase 6 search service. Two responsibilities:
 *
 *  - `search()`: the global & scoped palette endpoint. Runs one raw
 *    tsvector query against `search_index`, picks the correct tsvector
 *    column based on the caller's role (public for CLIENT_USER, full
 *    for operators), ranks with `ts_rank_cd + recency + archive
 *    penalty`, and enriches the top `limit` rows with the display
 *    metadata the palette needs (company name/slug, layout
 *    icon/color, article slug, upload thumbnail).
 *
 *  - `mentions()`: the Tiptap internal-link picker (also reused by
 *    the Linked-Items "Add link" modal). Uses the same index but
 *    only returns Asset, Article, and Password hits and skips
 *    snippet / comprehensive/archived machinery. Kept for
 *    compatibility with the editor code at
 *    `apps/web/src/components/rich-text/editor.tsx`.
 */
@Injectable()
export class SearchService {
  private readonly logger = new Logger(SearchService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ------------------------------------------------------------------
  // Global palette search
  // ------------------------------------------------------------------

  async search(
    actor: AuthedUser,
    req: SearchRequest,
  ): Promise<SearchRunResult> {
    const q = req.q.trim();
    const limit = Math.min(Math.max(req.limit ?? 10, 1), 50);
    const offset = Math.max(req.offset ?? 0, 0);
    const comprehensive = req.comprehensive === true;
    const includeArchived = req.includeArchived === true;
    const isClient = actor.role === 'CLIENT_USER';
    const ctx = requireTenantContext();

    const empty: SearchRunResult = {
      items: [],
      total: 0,
      companyId: req.companyId ?? null,
      comprehensive,
      includeArchived,
    };

    if (q.length === 0) return empty;

    // ---- scope ----
    //
    // Client + tech roles always carry an `allowedCompanyIds` scope.
    // Superadmins, and operators with non-NONE `globalAccess`, get
    // global access unless they explicitly asked for a company. A
    // caller with `companyId` passed (and that id in their scope) gets
    // company-scoped results; anything else yields the full allowed
    // scope.
    const hasGlobalScope =
      ctx.isSuperAdmin ||
      ctx.globalAccess === 'FULL' ||
      ctx.globalAccess === 'READONLY';
    const allowed = new Set(ctx.allowedCompanyIds);
    let scopeIds: string[] | 'global' = 'global';
    if (req.companyId) {
      if (!hasGlobalScope && !allowed.has(req.companyId)) return empty;
      scopeIds = [req.companyId];
    } else if (!hasGlobalScope) {
      scopeIds = ctx.allowedCompanyIds;
      if (scopeIds.length === 0) return empty;
    }

    // ---- entity-type filter ----
    const kinds: SearchEntityKind[] =
      req.types && req.types.length > 0
        ? req.types
        : [...searchEntityKinds];

    // ---- tsquery ----
    //
    // `websearch_to_tsquery` parses user-facing operator syntax
    // ("quoted phrase", -exclude, OR, implicit AND) safely; it never
    // throws on malformed input, which means we can hand it the raw
    // query string without pre-sanitising. Comprehensive mode ORs in
    // a prefix-match query derived from the last whitespace-separated
    // token so short queries also match longer stems.
    const useInternal = !isClient;
    const tsvectorCol = useInternal
      ? Prisma.raw('body_internal_tsv')
      : Prisma.raw('body_public_tsv');
    const bodyCol = useInternal
      ? Prisma.raw('body_internal')
      : Prisma.raw('body_public');

    const prefixLexeme = comprehensive ? this.lastLexeme(q) : '';
    const prefixClause = prefixLexeme
      ? Prisma.sql` || to_tsquery('english', ${prefixLexeme + ':*'})`
      : Prisma.empty;

    const tsq = Prisma.sql`
      (websearch_to_tsquery('english', ${q})${prefixClause})
    `;

    // ---- WHERE ----
    const whereParts: Prisma.Sql[] = [Prisma.sql`si.${tsvectorCol} @@ ${tsq}`];

    if (kinds.length < searchEntityKinds.length) {
      whereParts.push(
        Prisma.sql`si.entity_type IN (${Prisma.join(kinds)})`,
      );
    }

    if (scopeIds !== 'global') {
      whereParts.push(
        Prisma.sql`si.company_id IN (${Prisma.join(
          scopeIds.map((id) => Prisma.sql`${id}::uuid`),
        )})`,
      );
    }

    if (!includeArchived) {
      whereParts.push(Prisma.sql`si.archived_at IS NULL`);
    }

    if (isClient) {
      // Defence in depth: even though `body_public` already omits
      // hidden field text on assets and is empty for hidden articles,
      // we refuse to match any row whose entire source record was
      // marked `visible_to_clients = false`. This applies to Article,
      // MonitoredDomain, and Password rows; Upload + Asset rows are
      // always visible (with per-field redaction on assets via
      // body_public).
      whereParts.push(
        Prisma.sql`(si.entity_type NOT IN ('article', 'domain', 'password') OR si.visible_to_clients = true)`,
      );
    }

    if (!isClient && !ctx.isSuperAdmin) {
      // WS-001: `restricted_to_user_ids` mirrors the password
      // allow-list into the index so internal users who are not on a
      // restricted credential's allow-list never match it — same rule
      // `canReadPassword()` applies on every other read path. Client
      // users are exempt by policy (their gate is visible_to_clients,
      // above) and super admins always pass.
      whereParts.push(
        Prisma.sql`(si.entity_type <> 'password'
          OR si.restricted_to_user_ids = '{}'::uuid[]
          OR ${actor.id}::uuid = ANY(si.restricted_to_user_ids))`,
      );
    }

    const where = Prisma.join(whereParts, ' AND ');

    // ---- ORDER BY + rank ----
    //
    // `ts_rank_cd` gives us a cover-density score that weights word
    // proximity; we add a recency boost so two equally-relevant rows
    // prefer the more recently updated one, and a constant penalty
    // for archived rows so they sort to the bottom when
    // `includeArchived=true`.
    const scoreExpr = Prisma.sql`
      ts_rank_cd(si.${tsvectorCol}, ${tsq})
      + (1.0 / (1.0 + EXTRACT(EPOCH FROM (NOW() - si.updated_at)) / 86400.0))
      - CASE WHEN si.archived_at IS NOT NULL THEN 0.5 ELSE 0 END
    `;

    const snippetExpr = Prisma.sql`
      CASE
        WHEN char_length(si.${bodyCol}) > 0
          THEN ts_headline(
            'english',
            si.${bodyCol},
            ${tsq},
            'StartSel=<mark>, StopSel=</mark>, MaxWords=20, MinWords=8, MaxFragments=1, ShortWord=2'
          )
        ELSE ''
      END
    `;

    const rows = await this.prisma.$queryRaw<SearchIndexRow[]>(Prisma.sql`
      SELECT
        si.entity_type   AS entity_type,
        si.entity_id     AS entity_id,
        si.company_id    AS company_id,
        si.title         AS title,
        ${snippetExpr}   AS snippet,
        si.layout_id     AS layout_id,
        si.archived_at   AS archived_at,
        si.updated_at    AS updated_at,
        ${scoreExpr}     AS score
      FROM "search_index" si
      WHERE ${where}
      ORDER BY score DESC, si.updated_at DESC
      LIMIT ${limit}
      OFFSET ${offset}
    `);

    if (rows.length === 0) {
      return {
        items: [],
        total: 0,
        companyId: req.companyId ?? null,
        comprehensive,
        includeArchived,
      };
    }

    const hits = await this.enrich(rows, actor);

    return {
      items: hits,
      total: null,
      companyId: req.companyId ?? null,
      comprehensive,
      includeArchived,
    };
  }

  // ------------------------------------------------------------------
  // Enrichment — batch-fetch the display metadata the palette needs
  // ------------------------------------------------------------------

  private async enrich(
    rows: SearchIndexRow[],
    actor: AuthedUser,
  ): Promise<SearchHit[]> {
    const companyIds = new Set<string>();
    const layoutIds = new Set<string>();
    const articleIds = new Set<string>();
    const uploadIds = new Set<string>();

    for (const r of rows) {
      companyIds.add(r.company_id);
      if (r.layout_id) layoutIds.add(r.layout_id);
      if (r.entity_type === 'article') articleIds.add(r.entity_id);
      if (r.entity_type === 'upload') uploadIds.add(r.entity_id);
    }

    const [companies, layouts, articles, uploads] = await Promise.all([
      companyIds.size
        ? this.prisma.company.findMany({
            where: { id: { in: [...companyIds] } },
            select: { id: true, name: true, slug: true },
          })
        : Promise.resolve([] as Array<{ id: string; name: string; slug: string }>),
      layoutIds.size
        ? this.prisma.assetLayout.findMany({
            where: { id: { in: [...layoutIds] } },
            select: { id: true, icon: true, color: true, slug: true, name: true },
          })
        : Promise.resolve(
            [] as Array<{
              id: string;
              icon: string;
              color: string;
              slug: string;
              name: string;
            }>,
          ),
      articleIds.size
        ? this.prisma.article.findMany({
            where: { id: { in: [...articleIds] } },
            select: { id: true, slug: true, folderId: true },
          })
        : Promise.resolve(
            [] as Array<{ id: string; slug: string; folderId: string | null }>,
          ),
      uploadIds.size
        ? this.prisma.upload.findMany({
            where: { id: { in: [...uploadIds] } },
            select: { id: true, mimeType: true, isImage: true },
          })
        : Promise.resolve(
            [] as Array<{ id: string; mimeType: string; isImage: boolean }>,
          ),
    ]);

    const companyById = new Map(companies.map((c) => [c.id, c]));
    const layoutById = new Map(layouts.map((l) => [l.id, l]));
    const articleById = new Map(articles.map((a) => [a.id, a]));
    const uploadById = new Map(uploads.map((u) => [u.id, u]));
    const isClient = actor.role === 'CLIENT_USER';

    return rows.map((row) => {
      const company = companyById.get(row.company_id);
      const layout = row.layout_id ? layoutById.get(row.layout_id) : null;
      const article = articleById.get(row.entity_id);
      const upload = uploadById.get(row.entity_id);

      return {
        kind: row.entity_type,
        id: row.entity_id,
        title: row.title,
        snippet: this.sanitiseSnippet(row.snippet ?? ''),
        companyId: row.company_id,
        companyName: company?.name ?? '',
        companySlug: company?.slug ?? '',
        updatedAt: row.updated_at.toISOString(),
        archivedAt: row.archived_at ? row.archived_at.toISOString() : null,
        href: this.hrefFor(row, {
          companySlug: company?.slug ?? '',
          layoutSlug: layout?.slug ?? null,
          articleSlug: article?.slug ?? null,
          isClient,
        }),
        layoutIcon: layout?.icon ?? null,
        layoutColor: layout?.color ?? null,
        layoutName: layout?.name ?? null,
        folderId: article?.folderId ?? null,
        slug: article?.slug ?? null,
        thumbnailUrl: upload?.isImage ? null : null,
        mimeType: upload?.mimeType ?? null,
        score: Number(row.score),
      };
    });
  }

  // ------------------------------------------------------------------
  // URL construction
  //
  // Operators (SUPER_ADMIN, OPERATOR*, CONTRACTOR, TECH_LEAD) land on
  // admin URLs, clients on portal URLs. Portal asset detail pages
  // don't exist yet in v1 (see BUILD_PLAN Phase 4), so client asset
  // hits route to the layout's asset list page, which *does* exist.
  // ------------------------------------------------------------------

  private hrefFor(
    row: SearchIndexRow,
    ctx: {
      companySlug: string;
      layoutSlug: string | null;
      articleSlug: string | null;
      isClient: boolean;
    },
  ): string {
    const adminBase = `/admin/companies/${row.company_id}`;
    const portalBase = `/portal/${ctx.companySlug}`;
    const base = ctx.isClient ? portalBase : adminBase;
    switch (row.entity_type) {
      case 'asset':
        if (ctx.isClient && ctx.layoutSlug) {
          return `${base}/layouts/${ctx.layoutSlug}`;
        }
        return `${base}/assets/${row.entity_id}`;
      case 'article':
        if (ctx.isClient && ctx.articleSlug) {
          return `${base}/articles/${ctx.articleSlug}`;
        }
        return `${base}/articles/${row.entity_id}`;
      case 'upload':
        return `${base}/photos`;
      case 'domain':
        // Portal currently renders a read-only list only; operators get
        // a detail page. Both live under `/domains/:id` so the same
        // route works in either role.
        return `${base}/domains/${row.entity_id}`;
      case 'password':
        // Same path shape in admin + portal — the password detail page
        // exists in both routers and enforces its own visibility rules.
        return `${base}/passwords/${row.entity_id}`;
    }
  }

  // ------------------------------------------------------------------
  // Security: `ts_headline` is trustworthy for HTML-safety as long as
  // we don't inject attacker-controlled markers. We set
  // `StartSel=<mark>` / `StopSel=</mark>` ourselves; every other
  // character returned by Postgres is the original plaintext, which
  // we then escape so `&`, `<`, `>` become entities and only our
  // sentinel `<mark>` wrappers survive as real tags. The web palette
  // renders with `dangerouslySetInnerHTML` after this pass.
  // ------------------------------------------------------------------

  private sanitiseSnippet(raw: string): string {
    const escaped = raw
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    return escaped
      .replace(/&lt;mark&gt;/g, '<mark>')
      .replace(/&lt;\/mark&gt;/g, '</mark>');
  }

  /**
   * Extract the last whitespace-separated token and sanitise it into
   * a tsquery-safe lexeme (letters, digits, underscores). Returns ''
   * when the tail token doesn't yield any usable lexeme so callers
   * can skip the prefix OR entirely.
   */
  private lastLexeme(q: string): string {
    const parts = q.trim().split(/\s+/);
    const last = parts[parts.length - 1] ?? '';
    const lex = last.replace(/[^a-zA-Z0-9_]/g, '');
    return lex.length >= 2 ? lex.toLowerCase() : '';
  }

  // ------------------------------------------------------------------
  // Tiptap mention picker. Re-implemented on top of the Phase 6 index
  // so the editor gets the same ranking + visibility guarantees the
  // palette does.
  // ------------------------------------------------------------------

  async mentions(
    actor: AuthedUser,
    q: string,
    opts: { companyId?: string; kinds?: MentionKind[]; limit?: number } = {},
  ): Promise<MentionResult[]> {
    const needle = q.trim();
    if (needle.length === 0) return [];

    const kinds = new Set<MentionKind>(opts.kinds ?? ['asset', 'article', 'password']);
    const allowedKinds: SearchEntityKind[] = [];
    if (kinds.has('asset')) allowedKinds.push('asset');
    if (kinds.has('article')) allowedKinds.push('article');
    if (kinds.has('password')) allowedKinds.push('password');

    const result = await this.search(actor, {
      q: needle,
      companyId: opts.companyId,
      types: allowedKinds,
      limit: Math.min(Math.max(opts.limit ?? 10, 1), 25),
      // Mentions always excludes archived items — the author can't
      // @-link to an archived record anyway.
      includeArchived: false,
    });

    return result.items
      .filter(
        (h): h is SearchHit & { kind: MentionKind } =>
          h.kind === 'asset' || h.kind === 'article' || h.kind === 'password',
      )
      .map((h) => ({
        kind: h.kind,
        id: h.id,
        title: h.title,
        companyId: h.companyId,
        companyName: h.companyName,
        folderId: h.folderId ?? null,
        slug: h.slug ?? null,
        layoutIcon: h.layoutIcon ?? null,
        layoutColor: h.layoutColor ?? null,
        layoutName: h.layoutName ?? null,
        updatedAt: new Date(h.updatedAt),
      }));
  }
}
