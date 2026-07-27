/**
 * @jest-environment jsdom
 */
import '@testing-library/jest-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { AssetReferencePicker } from './AssetReferencePicker';
import { makeAsset, makeAssetsPage, makeLayoutField } from './test-fixtures';
import type { FieldEditorValue } from './field-values';

jest.mock('../../lib/api', () => {
  const actual = jest.requireActual('../../lib/api');
  return { ...actual, apiFetch: jest.fn() };
});
const { apiFetch } = jest.requireMock('../../lib/api') as { apiFetch: jest.Mock };

const COMPANY = 'c0000000-0000-4000-8000-0000000000c1';
const TARGET_LAYOUT = 'd0000000-0000-4000-8000-0000000000d2';
const CURRENT = 'b0000000-0000-4000-8000-0000000000b1';

const CANDIDATES = [
  makeAsset({ id: CURRENT, name: 'self-asset' }),
  makeAsset({ id: 'b0000000-0000-4000-8000-0000000000b2', name: 'core-sw-01' }),
  makeAsset({
    id: 'b0000000-0000-4000-8000-0000000000b3',
    name: 'old-sw-02',
    archivedAt: '2026-01-01T00:00:00.000Z',
  }),
];

function field(over: Record<string, unknown> = {}) {
  return makeLayoutField({
    slug: 'uplink',
    name: 'Uplink',
    fieldType: 'ASSET_REFERENCE',
    options: { targetLayoutId: TARGET_LAYOUT, multiple: false, ...over },
  });
}

function emptyRef(): Extract<FieldEditorValue, { kind: 'reference' }> {
  return { kind: 'reference', refs: [] };
}

function renderPicker(
  value = emptyRef(),
  fieldOver: Record<string, unknown> = {},
) {
  const onChange = jest.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  render(
    <Wrapper>
      <AssetReferencePicker
        field={field(fieldOver)}
        id="af-uplink"
        companyId={COMPANY}
        currentAssetId={CURRENT}
        value={value}
        onChange={onChange}
      />
    </Wrapper>,
  );
  return onChange;
}

beforeEach(() => {
  jest.clearAllMocks();
  apiFetch.mockResolvedValue(makeAssetsPage(CANDIDATES));
});

describe('AssetReferencePicker', () => {
  it('renders a diagnostic instead of a picker when targetLayoutId is missing', () => {
    renderPicker(emptyRef(), { targetLayoutId: undefined });
    expect(
      screen.getByText('This field’s target layout isn’t configured — edit it on desktop.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Choose/ })).not.toBeInTheDocument();
  });

  it('single mode: picking closes the sheet and replaces the value; self is excluded', async () => {
    const onChange = renderPicker();
    fireEvent.click(screen.getByRole('button', { name: 'Choose…' }));

    expect(await screen.findByRole('button', { name: /core-sw-01/ })).toBeInTheDocument();
    // The layout filter + limit reached the endpoint.
    expect(apiFetch.mock.calls[0]![0]).toContain(`layout=${TARGET_LAYOUT}`);
    // The asset being edited cannot reference itself.
    expect(screen.queryByRole('button', { name: /self-asset/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /core-sw-01/ }));
    expect(onChange).toHaveBeenCalledWith({
      kind: 'reference',
      refs: [{ id: 'b0000000-0000-4000-8000-0000000000b2', name: 'core-sw-01', archived: false }],
    });
    // Single mode closes on pick — the search field is gone.
    expect(screen.queryByPlaceholderText('Search by name…')).not.toBeInTheDocument();
  });

  it('multi mode: toggling adds refs and Done closes', async () => {
    const onChange = renderPicker(emptyRef(), { multiple: true });
    fireEvent.click(screen.getByRole('button', { name: 'Choose…' }));

    fireEvent.click(await screen.findByRole('button', { name: /core-sw-01/ }));
    expect(onChange).toHaveBeenCalledWith({
      kind: 'reference',
      refs: [{ id: 'b0000000-0000-4000-8000-0000000000b2', name: 'core-sw-01', archived: false }],
    });
    // Sheet stays open in multi mode; Done closes it.
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByPlaceholderText('Search by name…')).not.toBeInTheDocument();
  });

  it('archived candidates are pickable and marked', async () => {
    const onChange = renderPicker();
    fireEvent.click(screen.getByRole('button', { name: 'Choose…' }));
    fireEvent.click(await screen.findByRole('button', { name: /old-sw-02/ }));
    expect(onChange).toHaveBeenCalledWith({
      kind: 'reference',
      refs: [{ id: 'b0000000-0000-4000-8000-0000000000b3', name: 'old-sw-02', archived: true }],
    });
  });

  it('selected refs render as rows with a remove control; missing names show the id stub', () => {
    const onChange = renderPicker({
      kind: 'reference',
      refs: [
        { id: 'b0000000-0000-4000-8000-0000000000b2', name: 'core-sw-01', archived: false },
        { id: 'ffffffff-0000-4000-8000-000000000009', name: null, archived: false },
      ],
    });
    expect(screen.getByText('core-sw-01')).toBeInTheDocument();
    expect(screen.getByText('ffffffff… (missing)')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove core-sw-01' }));
    expect(onChange).toHaveBeenCalledWith({
      kind: 'reference',
      refs: [{ id: 'ffffffff-0000-4000-8000-000000000009', name: null, archived: false }],
    });
  });
});
