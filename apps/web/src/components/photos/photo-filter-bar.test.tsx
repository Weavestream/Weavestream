/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { PhotoFilterBar } from './photo-filter-bar';

const ADMIN = '/admin/companies/c1/photos';
const PORTAL = '/portal/acme/photos';
const ID = '22222222-2222-4222-8222-222222222222';

function hrefOf(name: string | RegExp) {
  return screen.getByRole('link', { name }).getAttribute('href');
}

describe('PhotoFilterBar — portal (no audit toggle)', () => {
  it('renders no toggle and no includeNonLatest on any link', () => {
    render(
      <PhotoFilterBar
        basePath={PORTAL}
        attachedToType="asset"
        attachedToId={ID}
        count={3}
      />,
    );
    expect(
      screen.queryByRole('link', { name: /orphaned/ }),
    ).not.toBeInTheDocument();
    for (const link of screen.getAllByRole('link')) {
      expect(link.getAttribute('href')).not.toContain('includeNonLatest');
    }
  });

  it('keeps the id filter on every pill, "All" included', () => {
    render(
      <PhotoFilterBar
        basePath={PORTAL}
        attachedToType="asset"
        attachedToId={ID}
        count={3}
      />,
    );
    expect(hrefOf('All')).toBe(`${PORTAL}?attachedToId=${ID}`);
    expect(hrefOf('Articles')).toBe(
      `${PORTAL}?attachedToType=article&attachedToId=${ID}`,
    );
    expect(screen.getByTitle('Clear id filter')).toHaveAttribute(
      'href',
      `${PORTAL}?attachedToType=asset`,
    );
  });

  it('marks the active pill', () => {
    render(<PhotoFilterBar basePath={PORTAL} attachedToType="article" count={0} />);
    expect(screen.getByRole('link', { name: 'Articles' })).toHaveStyle({
      color: 'var(--accent)',
    });
    expect(screen.getByRole('link', { name: 'All' })).toHaveStyle({
      color: 'var(--muted)',
    });
  });

  it('hides the id chip without an id filter', () => {
    render(<PhotoFilterBar basePath={PORTAL} count={0} />);
    expect(screen.queryByTitle('Clear id filter')).not.toBeInTheDocument();
  });

  it.each([
    [0, '0 photos'],
    [1, '1 photo'],
    [2, '2 photos'],
  ])('counts %i as "%s"', (count, text) => {
    render(<PhotoFilterBar basePath={PORTAL} count={count} />);
    expect(screen.getByText(text)).toBeInTheDocument();
  });
});

describe('PhotoFilterBar — admin (audit toggle)', () => {
  it('turns the toggle on and keeps the other filters', () => {
    render(
      <PhotoFilterBar
        basePath={ADMIN}
        attachedToType="asset"
        attachedToId={ID}
        count={3}
        nonLatest={{ included: false }}
      />,
    );
    expect(hrefOf(/orphaned/)).toBe(
      `${ADMIN}?attachedToType=asset&attachedToId=${ID}&includeNonLatest=1`,
    );
    expect(hrefOf('All')).toBe(`${ADMIN}?attachedToId=${ID}`);
    expect(screen.getByText('3 photos')).toBeInTheDocument();
  });

  it('carries the toggle on every link while it is on', () => {
    render(
      <PhotoFilterBar
        basePath={ADMIN}
        attachedToType="asset"
        attachedToId={ID}
        count={2}
        nonLatest={{ included: true }}
      />,
    );
    expect(hrefOf(/orphaned/)).toBe(
      `${ADMIN}?attachedToType=asset&attachedToId=${ID}`,
    );
    expect(hrefOf('Articles')).toBe(
      `${ADMIN}?attachedToType=article&attachedToId=${ID}&includeNonLatest=1`,
    );
    expect(screen.getByTitle('Clear id filter')).toHaveAttribute(
      'href',
      `${ADMIN}?attachedToType=asset&includeNonLatest=1`,
    );
    expect(screen.getByText('2 photos (incl. non-live)')).toBeInTheDocument();
  });
});
