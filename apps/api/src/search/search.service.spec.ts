import { SearchService } from './search.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';

/**
 * Unit tests for the pure helpers inside SearchService that don't
 * need a Postgres instance. The raw tsvector query itself is covered
 * by manual QA + reindex smoke tests — those require a real DB and
 * would drift any in-memory mock quickly.
 *
 * We use `as unknown as SearchService` + bracket access to reach the
 * private methods. Keeping them private in the production type is
 * still valuable (external callers should go through `search()`),
 * and the test contract is narrow enough that this is fine.
 */
describe('SearchService helpers', () => {
  const svc = new SearchService(
    {} as unknown as PrismaService,
  ) as unknown as {
    sanitiseSnippet: (raw: string) => string;
    hrefFor: (
      row: {
        entity_type: 'asset' | 'article' | 'upload';
        entity_id: string;
        company_id: string;
      },
      ctx: {
        companySlug: string;
        layoutSlug: string | null;
        articleSlug: string | null;
        isClient: boolean;
      },
    ) => string;
    lastLexeme: (q: string) => string;
  };

  describe('sanitiseSnippet', () => {
    it('escapes HTML entities and preserves only <mark> tags', () => {
      const raw = 'before <mark>target</mark> & <script>bad</script>';
      const cleaned = svc.sanitiseSnippet(raw);
      expect(cleaned).toContain('<mark>target</mark>');
      expect(cleaned).toContain('&amp;');
      expect(cleaned).not.toContain('<script>');
      expect(cleaned).toContain('&lt;script&gt;');
    });

    it('returns empty string when no markers present', () => {
      const cleaned = svc.sanitiseSnippet('plain text');
      expect(cleaned).toBe('plain text');
    });
  });

  describe('hrefFor', () => {
    const assetRow = {
      entity_type: 'asset' as const,
      entity_id: '11111111-1111-1111-1111-111111111111',
      company_id: '22222222-2222-2222-2222-222222222222',
    };
    const articleRow = { ...assetRow, entity_type: 'article' as const };
    const uploadRow = { ...assetRow, entity_type: 'upload' as const };

    it('routes operators to admin asset detail URL', () => {
      const href = svc.hrefFor(assetRow, {
        companySlug: 'acme',
        layoutSlug: 'firewall',
        articleSlug: null,
        isClient: false,
      });
      expect(href).toBe(
        '/admin/companies/22222222-2222-2222-2222-222222222222/assets/11111111-1111-1111-1111-111111111111',
      );
    });

    it('routes clients to portal layout page for assets', () => {
      const href = svc.hrefFor(assetRow, {
        companySlug: 'acme',
        layoutSlug: 'firewall',
        articleSlug: null,
        isClient: true,
      });
      expect(href).toBe('/portal/acme/layouts/firewall');
    });

    it('uses article slug for portal article URLs', () => {
      const href = svc.hrefFor(articleRow, {
        companySlug: 'acme',
        layoutSlug: null,
        articleSlug: 'runbook-reboot',
        isClient: true,
      });
      expect(href).toBe('/portal/acme/articles/runbook-reboot');
    });

    it('routes uploads to the photos gallery in both admin and portal', () => {
      expect(
        svc.hrefFor(uploadRow, {
          companySlug: 'acme',
          layoutSlug: null,
          articleSlug: null,
          isClient: false,
        }),
      ).toBe(
        '/admin/companies/22222222-2222-2222-2222-222222222222/photos',
      );
      expect(
        svc.hrefFor(uploadRow, {
          companySlug: 'acme',
          layoutSlug: null,
          articleSlug: null,
          isClient: true,
        }),
      ).toBe('/portal/acme/photos');
    });
  });

  describe('lastLexeme', () => {
    it('extracts the last token with letters/digits', () => {
      expect(svc.lastLexeme('admin gateway')).toBe('gateway');
      expect(svc.lastLexeme('single')).toBe('single');
    });

    it('returns empty when the last token is too short', () => {
      expect(svc.lastLexeme('foo a')).toBe('');
    });

    it('strips non-alphanumeric characters', () => {
      expect(svc.lastLexeme('router-01')).toBe('router01');
    });
  });
});
