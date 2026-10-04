/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { PhotoEmptyState, PhotoLoadMore } from './photo-gallery';

const ID = '22222222-2222-4222-8222-222222222222';

describe('PhotoEmptyState', () => {
  it('shows the message and hint without an icon (admin copy)', () => {
    const { container } = render(
      <PhotoEmptyState message="No photos yet." hint="Attach an image." />,
    );
    expect(screen.getByText('No photos yet.')).toBeInTheDocument();
    expect(screen.getByText('Attach an image.')).toBeInTheDocument();
    expect(container.querySelector('svg')).toBeNull();
  });

  it('shows the icon and no hint (portal copy)', () => {
    const { container } = render(
      <PhotoEmptyState message="No photos shared yet." showIcon />,
    );
    expect(screen.getByText('No photos shared yet.')).toBeInTheDocument();
    expect(container.querySelector('svg')).not.toBeNull();
  });
});

describe('PhotoLoadMore', () => {
  it('renders nothing on the last page', () => {
    const { container } = render(
      <PhotoLoadMore basePath="/portal/acme/photos" nextCursor={null} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('keeps the portal filters and adds the cursor', () => {
    render(
      <PhotoLoadMore
        basePath="/portal/acme/photos"
        nextCursor="c2"
        attachedToType="asset"
        attachedToId={ID}
      />,
    );
    expect(screen.getByRole('link', { name: 'Load more →' })).toHaveAttribute(
      'href',
      `/portal/acme/photos?attachedToType=asset&attachedToId=${ID}&cursor=c2`,
    );
  });

  it('keeps the admin audit toggle', () => {
    render(
      <PhotoLoadMore
        basePath="/admin/companies/c1/photos"
        nextCursor="c2"
        includeNonLatest
      />,
    );
    expect(screen.getByRole('link', { name: 'Load more →' })).toHaveAttribute(
      'href',
      '/admin/companies/c1/photos?includeNonLatest=1&cursor=c2',
    );
  });
});
