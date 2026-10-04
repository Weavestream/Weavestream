/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { makePhoto } from '../../../../../components/photos/test-photo';
import { AdminPhotoTile } from './admin-photo-tile';

// The real chip is a client island with router/toast/API dependencies;
// the stub only proves when it is offered and with which state.
jest.mock('./photo-delete-chip', () => ({
  PhotoDeleteChip: ({ state }: { state: string }) => (
    <button type="button">Delete ({state})</button>
  ),
}));

const COMPANY = 'c1';
const ASSET_ID = '22222222-2222-4222-8222-222222222222';
const ARTICLE = { id: 'art-1', slug: 'how-to', title: 'How to' };

function renderTile(photo: Parameters<typeof makePhoto>[0]) {
  return render(<AdminPhotoTile photo={makePhoto(photo)} companyId={COMPANY} />);
}

describe('AdminPhotoTile', () => {
  it.each(['asset', 'asset_field'])(
    'links a %s upload to its asset and to related photos',
    (type) => {
      renderTile({ attachedToType: type, attachedToId: ASSET_ID });
      expect(screen.getByRole('link', { name: /^Open source/ })).toHaveAttribute(
        'href',
        `/admin/companies/${COMPANY}/assets/${ASSET_ID}`,
      );
      expect(
        screen.getByRole('link', { name: /^View all photos/ }),
      ).toHaveAttribute(
        'href',
        `/admin/companies/${COMPANY}/photos?attachedToType=${type}&attachedToId=${ASSET_ID}`,
      );
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
    },
  );

  it('opens a live article image by id, with no badge or related link', () => {
    renderTile({
      attachedToType: 'article',
      attachedToId: null,
      sourceArticle: ARTICLE,
      articleLinkState: 'live',
    });
    expect(
      screen.getByRole('link', { name: 'Open article: How to' }),
    ).toHaveAttribute('href', `/admin/companies/${COMPANY}/articles/art-1`);
    expect(screen.queryByRole('link', { name: /^View all/ })).not.toBeInTheDocument();
    expect(screen.queryByText('Archived')).not.toBeInTheDocument();
  });

  it('badges an archived article image and offers Open and Delete', () => {
    renderTile({
      attachedToType: 'article',
      attachedToId: null,
      sourceArticle: ARTICLE,
      articleLinkState: 'archived',
    });
    expect(screen.getByText('Archived')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Open archived article: How to' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete (archived)' })).toBeInTheDocument();
  });

  it('badges a versioned image with no actions at all', () => {
    renderTile({
      attachedToType: 'article',
      attachedToId: null,
      sourceArticle: ARTICLE,
      articleLinkState: 'versioned',
    });
    expect(screen.getByText('Old version')).toBeInTheDocument();
    // Only the thumbnail download link remains.
    expect(screen.getAllByRole('link')).toHaveLength(1);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('badges an orphan and offers only Delete', () => {
    renderTile({
      attachedToType: 'article',
      attachedToId: null,
      sourceArticle: null,
      articleLinkState: 'orphan',
    });
    expect(screen.getByText('Orphan')).toBeInTheDocument();
    expect(screen.getAllByRole('link')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Delete (orphan)' })).toBeInTheDocument();
  });

  it('offers nothing for a detached upload', () => {
    renderTile({ attachedToType: null, attachedToId: null });
    expect(screen.getByText('detached')).toBeInTheDocument();
    expect(screen.getAllByRole('link')).toHaveLength(1);
  });
});
