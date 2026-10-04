/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { makePhoto } from '../../../../components/photos/test-photo';
import { PortalPhotoTile } from './portal-photo-tile';

const ARTICLE = { id: 'art-1', slug: 'how to/reset', title: 'How to reset' };

describe('PortalPhotoTile', () => {
  it('opens an article image by its encoded slug on the portal', () => {
    render(
      <PortalPhotoTile
        companySlug="acme"
        photo={makePhoto({
          attachedToType: 'article',
          attachedToId: null,
          sourceArticle: ARTICLE,
          articleLinkState: 'live',
        })}
      />,
    );
    const open = screen.getByRole('link', { name: 'Open article: How to reset' });
    expect(open).toHaveAttribute(
      'href',
      '/portal/acme/articles/how%20to%2Freset',
    );
    expect(open.getAttribute('href')).not.toContain('/admin/');
  });

  it.each(['asset', 'asset_field'])(
    'offers no actions for a %s upload',
    (type) => {
      render(
        <PortalPhotoTile
          companySlug="acme"
          photo={makePhoto({ attachedToType: type, attachedToId: 'a1' })}
        />,
      );
      // Only the thumbnail download link.
      expect(screen.getAllByRole('link')).toHaveLength(1);
    },
  );

  it('never shows admin link-state badges', () => {
    render(
      <PortalPhotoTile
        companySlug="acme"
        photo={makePhoto({
          attachedToType: 'article',
          attachedToId: null,
          sourceArticle: null,
          articleLinkState: 'orphan',
        })}
      />,
    );
    expect(screen.queryByText('Orphan')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getAllByRole('link')).toHaveLength(1);
  });
});
