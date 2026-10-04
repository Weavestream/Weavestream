/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import type { AssetSummary } from '@weavestream/shared';
import { AssetDetailView } from './asset-detail-view';
import type { AssetFieldContext } from './asset-field-value';

// Tiptap does not render in jsdom; the stub shows the value text and the
// routing props so panel content and mention context are both asserted.
jest.mock('../editor/rich-text-view', () => ({
  RichTextView: (props: {
    value: unknown;
    isAdmin?: boolean;
    fallbackCompanyId?: string;
  }) => (
    <div
      data-testid="rich-text"
      data-admin={String(props.isAdmin)}
      data-fallback={props.fallbackCompanyId}
    >
      {String(props.value)}
    </div>
  ),
}));

type Asset = Pick<AssetSummary, 'fields' | 'fieldValues' | 'references'>;
type Field = AssetSummary['fields'][number];

const COMPANY_ID = '11111111-1111-4111-8111-111111111111';

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

function field(
  slug: string,
  name: string,
  fieldType: string,
  isPrimary = false,
): Field {
  return {
    id: `f-${slug}`,
    slug,
    name,
    fieldType,
    options: {},
    isPrimary,
  } as unknown as Field;
}

// Mirrors the AcmePortal fixture: several note fields, one of them empty,
// with ordinary fields between them.
const asset: Asset = {
  fields: [
    field('name', 'Application name', 'TEXT', true),
    field('impact', 'Business impact', 'RICH_TEXT'),
    field('vendor', 'Vendor', 'TEXT'),
    field('steps', 'New user setup steps', 'TEXTAREA'),
    field('notes', 'Notes', 'RICH_TEXT'),
    field('empty_notes', 'Empty notes', 'TEXTAREA'),
  ],
  fieldValues: {
    name: 'AcmePortal',
    impact: 'Impact body',
    vendor: 'Acme',
    steps: 'Step 1\nStep 2',
    notes: 'Notes body',
    empty_notes: '',
  },
  references: {},
} as unknown as Asset;

function renderView(context: AssetFieldContext = adminContext) {
  return render(<AssetDetailView asset={asset} context={context} />);
}

describe('AssetDetailView', () => {
  it('lists only non-note fields in the grid, in layout order', () => {
    const { container } = renderView();
    const labels = [
      ...container.querySelectorAll('.asset-field-grid > .asset-field-label'),
    ].map((el) => el.textContent);
    expect(labels).toEqual(['Application nameprimary', 'Vendor']);
  });

  it('marks the primary field', () => {
    renderView();
    expect(screen.getByText('primary')).toBeInTheDocument();
  });

  it('gives every non-empty note field its own panel, in layout order', () => {
    const { container } = renderView();
    const text = container.textContent ?? '';
    const order = ['Business impact', 'New user setup steps', 'Notes'].map(
      (title) => text.indexOf(title),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(screen.getByText('Impact body')).toBeInTheDocument();
    expect(screen.getByText('Notes body')).toBeInTheDocument();
    expect(screen.getByText(/Step 1\s+Step 2/)).toBeInTheDocument();
  });

  it('omits an empty note field entirely', () => {
    renderView();
    expect(screen.queryByText('Empty notes')).not.toBeInTheDocument();
  });

  it('shows every note panel on the portal too', () => {
    renderView(portalContext);
    expect(screen.getAllByTestId('rich-text')).toHaveLength(2);
    expect(screen.getByText(/Step 1\s+Step 2/)).toBeInTheDocument();
  });

  it.each([
    ['admin', adminContext, 'true'],
    ['portal', portalContext, 'false'],
  ])('passes %s mention routing to note panels', (_, context, admin) => {
    renderView(context);
    for (const view of screen.getAllByTestId('rich-text')) {
      expect(view).toHaveAttribute('data-admin', admin);
      expect(view).toHaveAttribute('data-fallback', COMPANY_ID);
    }
  });
});
