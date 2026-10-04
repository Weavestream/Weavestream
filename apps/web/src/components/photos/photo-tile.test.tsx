/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { PhotoActionChip, PhotoTile } from './photo-tile';
import { makePhoto } from './test-photo';

describe('PhotoTile', () => {
  it('opens the download from the thumbnail', () => {
    render(<PhotoTile photo={makePhoto()} />);
    const img = screen.getByRole('img', { name: 'rack.jpg' });
    expect(img).toHaveAttribute('src', '/api/v1/uploads/u1/thumb');
    const link = img.closest('a');
    expect(link).toHaveAttribute('href', '/api/v1/uploads/u1/download');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');
  });

  it('falls back to # and an icon without URLs', () => {
    const { container } = render(
      <PhotoTile photo={makePhoto({ thumbnailUrl: null, downloadUrl: null })} />,
    );
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(container.querySelector('a')).toHaveAttribute('href', '#');
  });

  it.each([
    ['asset', 'Attachment'],
    ['asset_field', 'Asset'],
    ['article', 'Article'],
    [null, 'detached'],
  ])('labels attachedToType %p as "%s"', (type, label) => {
    render(<PhotoTile photo={makePhoto({ attachedToType: type })} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it('shows pixel size only when both dimensions are known', () => {
    const { rerender } = render(<PhotoTile photo={makePhoto()} />);
    expect(screen.getByText('1600×1200')).toBeInTheDocument();
    rerender(<PhotoTile photo={makePhoto({ height: null })} />);
    expect(screen.queryByText(/×/)).not.toBeInTheDocument();
  });

  it('renders the badge and action slots', () => {
    render(
      <PhotoTile
        photo={makePhoto()}
        badges={<span>Badge</span>}
        actions={<button type="button">Act</button>}
      />,
    );
    expect(screen.getByText('Badge')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Act' })).toBeInTheDocument();
  });

  it('renders no action row for null actions', () => {
    const { container } = render(<PhotoTile photo={makePhoto()} actions={null} />);
    // Thumbnail link + body; the body holds only the filename and meta line.
    const body = container.firstElementChild!.children[1]!;
    expect(body.children).toHaveLength(2);
  });
});

describe('PhotoActionChip', () => {
  it('links with its title as the accessible name', () => {
    render(
      <PhotoActionChip href="/x" icon={null} label="Open" title="Open article: Y" />,
    );
    const link = screen.getByRole('link', { name: 'Open article: Y' });
    expect(link).toHaveAttribute('href', '/x');
    expect(link).toHaveStyle({ color: 'var(--accent)' });
  });

  it('uses the muted tone on request', () => {
    render(
      <PhotoActionChip
        href="/x"
        icon={null}
        label="Related"
        tone="muted"
        title="View all"
      />,
    );
    expect(screen.getByRole('link', { name: 'View all' })).toHaveStyle({
      color: 'var(--muted)',
    });
  });
});
