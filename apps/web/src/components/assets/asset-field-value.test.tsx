/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import type { AssetSummary } from '@weavestream/shared';
import { AssetFieldValue, type AssetFieldContext } from './asset-field-value';

// Tiptap does not render in jsdom; the stub surfaces the routing props so
// the admin/portal mention context is still asserted.
jest.mock('../editor/rich-text-view', () => ({
  RichTextView: (props: {
    isAdmin?: boolean;
    portalSlugByCompanyId?: Record<string, string>;
    fallbackCompanyId?: string;
  }) => (
    <div
      data-testid="rich-text"
      data-admin={String(props.isAdmin)}
      data-slugs={JSON.stringify(props.portalSlugByCompanyId ?? null)}
      data-fallback={props.fallbackCompanyId}
    />
  ),
}));

type Field = AssetSummary['fields'][number];
type References = AssetSummary['references'];

const COMPANY_ID = '11111111-1111-4111-8111-111111111111';
const LIVE_REF = '22222222-2222-4222-8222-222222222222';
const ARCHIVED_REF = '33333333-3333-4333-8333-333333333333';
const MISSING_REF = '44444444-4444-4444-8444-444444444444';

const adminContext: AssetFieldContext = {
  assetHrefBase: `/admin/companies/${COMPANY_ID}/assets`,
  richText: { isAdmin: true, fallbackCompanyId: COMPANY_ID },
};

const portalContext: AssetFieldContext = {
  assetHrefBase: '/portal/acme/assets',
  richText: {
    isAdmin: false,
    portalSlugByCompanyId: { [COMPANY_ID]: 'acme' },
    fallbackCompanyId: COMPANY_ID,
  },
};

const references = {
  [LIVE_REF]: { name: 'Core switch', archivedAt: null },
  [ARCHIVED_REF]: { name: 'Old router', archivedAt: '2026-01-01T00:00:00Z' },
} as unknown as References;

function field(fieldType: string, options: Record<string, unknown> = {}): Field {
  return {
    id: `f-${fieldType}`,
    slug: fieldType.toLowerCase(),
    name: fieldType,
    fieldType,
    options,
    isPrimary: false,
  } as unknown as Field;
}

function renderValue(
  f: Field,
  value: unknown,
  context: AssetFieldContext = adminContext,
) {
  return render(
    <AssetFieldValue
      field={f}
      value={value}
      references={references}
      context={context}
    />,
  );
}

describe('AssetFieldValue', () => {
  it.each([null, undefined, ''])('renders — for an empty value (%p)', (v) => {
    renderValue(field('TEXT'), v);
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  describe('ASSET_REFERENCE', () => {
    const ref = field('ASSET_REFERENCE');

    it('links a resolved reference under the admin base', () => {
      renderValue(ref, [LIVE_REF], adminContext);
      expect(screen.getByRole('link', { name: 'Core switch' })).toHaveAttribute(
        'href',
        `/admin/companies/${COMPANY_ID}/assets/${LIVE_REF}`,
      );
    });

    it('links a resolved reference under the portal base, never admin', () => {
      renderValue(ref, [LIVE_REF], portalContext);
      const link = screen.getByRole('link', { name: 'Core switch' });
      expect(link).toHaveAttribute('href', `/portal/acme/assets/${LIVE_REF}`);
      expect(link.getAttribute('href')).not.toContain('/admin/');
    });

    it('accepts a single id as well as an array', () => {
      renderValue(ref, LIVE_REF);
      expect(screen.getByRole('link', { name: 'Core switch' })).toBeInTheDocument();
    });

    it('strikes through an archived reference', () => {
      renderValue(ref, [ARCHIVED_REF]);
      expect(screen.getByText('Old router')).toHaveStyle({
        textDecoration: 'line-through',
      });
    });

    it('shows a missing reference as an unlinked chip', () => {
      renderValue(ref, [MISSING_REF]);
      expect(screen.queryByRole('link')).not.toBeInTheDocument();
      expect(screen.getByText('44444444… (missing)')).toBeInTheDocument();
    });
  });

  describe('RICH_TEXT', () => {
    it('passes admin mention routing', () => {
      renderValue(field('RICH_TEXT'), { type: 'doc' }, adminContext);
      const view = screen.getByTestId('rich-text');
      expect(view).toHaveAttribute('data-admin', 'true');
      expect(view).toHaveAttribute('data-slugs', 'null');
      expect(view).toHaveAttribute('data-fallback', COMPANY_ID);
    });

    it('passes portal mention routing', () => {
      renderValue(field('RICH_TEXT'), { type: 'doc' }, portalContext);
      const view = screen.getByTestId('rich-text');
      expect(view).toHaveAttribute('data-admin', 'false');
      expect(view).toHaveAttribute(
        'data-slugs',
        JSON.stringify({ [COMPANY_ID]: 'acme' }),
      );
    });
  });

  describe('FILE', () => {
    it('renders one download tile per entry', () => {
      renderValue(field('FILE'), [
        {
          uploadId: 'u1',
          filename: 'rack.jpg',
          mimeType: 'image/jpeg',
          sizeBytes: 2048,
          thumbnailUrl: '/api/v1/uploads/u1/thumb',
          downloadUrl: '/api/v1/uploads/u1/download',
        },
        {
          uploadId: 'u2',
          filename: 'manual.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 10,
          downloadUrl: null,
        },
      ]);
      const links = screen.getAllByRole('link');
      expect(links).toHaveLength(2);
      expect(links[0]).toHaveAttribute('href', '/api/v1/uploads/u1/download');
      expect(links[0]).toHaveAttribute('target', '_blank');
      expect(links[0]).toHaveAttribute('rel', 'noreferrer');
      expect(screen.getByRole('img', { name: 'rack.jpg' })).toHaveAttribute(
        'src',
        '/api/v1/uploads/u1/thumb',
      );
      expect(links[1]).toHaveAttribute('href', '#');
      expect(screen.getByText('manual.pdf')).toBeInTheDocument();
    });

    it('renders — for an empty entry list', () => {
      renderValue(field('FILE'), []);
      expect(screen.getByText('—')).toBeInTheDocument();
    });
  });

  describe('DATE / DATETIME', () => {
    it('pins a DATE to its calendar day', () => {
      renderValue(field('DATE'), '2026-03-14');
      expect(screen.getByText('Mar 14, 2026')).toHaveAttribute(
        'title',
        '2026-03-14',
      );
    });

    it('shows the raw string for an unparseable date', () => {
      renderValue(field('DATETIME'), 'not a date');
      expect(screen.getByText('not a date')).toBeInTheDocument();
    });
  });

  it('maps DROPDOWN and MULTISELECT slugs to labels', () => {
    const choices = [
      { slug: 'prod', label: 'Production' },
      { slug: 'dev', label: 'Development' },
    ];
    const { unmount } = renderValue(field('DROPDOWN', { choices }), 'prod');
    expect(screen.getByText('Production')).toBeInTheDocument();
    unmount();

    renderValue(field('MULTISELECT', { choices }), ['dev', 'unknown']);
    expect(screen.getByText('Development')).toBeInTheDocument();
    expect(screen.getByText('unknown')).toBeInTheDocument();
  });

  it('renders hydrated and legacy TAGS entries', () => {
    renderValue(field('TAGS'), [{ id: 't1', name: 'Critical' }, 'legacy']);
    expect(screen.getByText('Critical')).toBeInTheDocument();
    expect(screen.getByText('legacy')).toBeInTheDocument();
  });

  it('renders BOOLEAN as a true/false tag', () => {
    renderValue(field('BOOLEAN'), false);
    expect(screen.getByText('false')).toBeInTheDocument();
  });

  it('renders EMAIL as a mailto link', () => {
    renderValue(field('EMAIL'), 'ops@example.com');
    expect(screen.getByRole('link', { name: 'ops@example.com' })).toHaveAttribute(
      'href',
      'mailto:ops@example.com',
    );
  });
});
