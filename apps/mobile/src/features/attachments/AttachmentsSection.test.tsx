/**
 * @jest-environment jsdom
 */
import '@testing-library/jest-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { ApiError } from '../../lib/api';
import { AttachmentsSection } from './AttachmentsSection';
import type { Attachment, AttachmentEntityType } from './api';

jest.mock('../../lib/api', () => {
  const actual = jest.requireActual('../../lib/api');
  return { ...actual, apiFetch: jest.fn() };
});

const { apiFetch } = jest.requireMock('../../lib/api') as { apiFetch: jest.Mock };

const CO = 'c0000000-0000-4000-8000-0000000000c1';
const ENTITY = 'e0000000-0000-4000-8000-0000000000e1';

function makeAttachment(over: Partial<Attachment> = {}): Attachment {
  return {
    id: 'u0000000-0000-4000-8000-0000000000u1',
    filename: 'rack-diagram.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 2048,
    isImage: false,
    thumbnailUrl: null,
    downloadUrl: `/api/v1/companies/${CO}/uploads/u1/image`,
    createdAt: '2026-07-20T10:00:00.000Z',
    ...over,
  };
}

function renderSection(entityType: AttachmentEntityType = 'asset') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return render(
    <Wrapper>
      <AttachmentsSection companyId={CO} entityType={entityType} entityId={ENTITY} />
    </Wrapper>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('AttachmentsSection', () => {
  it('lists attachments as openable tiles', async () => {
    apiFetch.mockResolvedValue({
      items: [makeAttachment()],
      nextCursor: null,
    });
    renderSection();

    expect(await screen.findByText('rack-diagram.pdf')).toBeInTheDocument();
    expect(screen.getByText('Attachments')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open rack-diagram.pdf' })).toHaveAttribute(
      'href',
      `/api/v1/companies/${CO}/uploads/u1/image`,
    );
  });

  it('sends both required filters, scoped to the entity', async () => {
    apiFetch.mockResolvedValue({ items: [], nextCursor: null });
    renderSection('password');

    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    const path = apiFetch.mock.calls[0]![0] as string;
    expect(path).toContain(`/companies/${CO}/uploads`);
    expect(path).toContain('attachedToType=password');
    expect(path).toContain(`attachedToId=${ENTITY}`);
  });

  it('renders nothing at all when the entity has no attachments', async () => {
    apiFetch.mockResolvedValue({ items: [], nextCursor: null });
    const { container } = renderSection();

    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(screen.queryByText('Attachments')).not.toBeInTheDocument();
  });

  it('shows a thumbnail for an image and the doc glyph otherwise', async () => {
    apiFetch.mockResolvedValue({
      items: [
        makeAttachment({
          id: 'img',
          filename: 'serial-plate.jpg',
          mimeType: 'image/jpeg',
          isImage: true,
          thumbnailUrl: `/api/v1/companies/${CO}/uploads/img/image?v=thumb`,
        }),
        makeAttachment({ id: 'doc' }),
      ],
      nextCursor: null,
    });
    const { container } = renderSection();

    await screen.findByText('serial-plate.jpg');
    const img = container.querySelector('img');
    expect(img).toHaveAttribute(
      'src',
      `/api/v1/companies/${CO}/uploads/img/image?v=thumb`,
    );
    // Two tiles, one thumbnail — the PDF falls back to the icon.
    expect(container.querySelectorAll('img')).toHaveLength(1);
  });

  it('treats an image mime as an image even when isImage is false', async () => {
    apiFetch.mockResolvedValue({
      items: [
        makeAttachment({
          filename: 'closet.png',
          mimeType: 'image/png',
          isImage: false,
          thumbnailUrl: '/api/v1/thumb.webp',
        }),
      ],
      nextCursor: null,
    });
    const { container } = renderSection();

    await screen.findByText('closet.png');
    expect(container.querySelector('img')).toHaveAttribute('src', '/api/v1/thumb.webp');
  });

  it('renders a deleted upload dimmed and inert rather than dropping it', async () => {
    apiFetch.mockResolvedValue({
      items: [makeAttachment({ downloadUrl: null })],
      nextCursor: null,
    });
    renderSection();

    expect(await screen.findByText('rack-diagram.pdf')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('surfaces a failed read instead of looking like "no attachments"', async () => {
    apiFetch.mockRejectedValue(new ApiError(500, null));
    renderSection();

    expect(await screen.findByText(/couldn’t load attachments/i)).toBeInTheDocument();
    // The label still renders, so the section is visibly present-but-broken
    // rather than absent.
    expect(screen.getByText('Attachments')).toBeInTheDocument();

    apiFetch.mockResolvedValue({ items: [makeAttachment()], nextCursor: null });
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(await screen.findByText('rack-diagram.pdf')).toBeInTheDocument();
    expect(screen.queryByText(/couldn’t load attachments/i)).not.toBeInTheDocument();
  });

  it('says so when the server had more than one page', async () => {
    apiFetch.mockResolvedValue({
      items: [makeAttachment()],
      nextCursor: 'u0000000-0000-4000-8000-0000000000u9',
    });
    renderSection();

    expect(await screen.findByText(/showing the most recent 1/i)).toBeInTheDocument();
  });

  it('stays quiet about paging when the whole list arrived', async () => {
    apiFetch.mockResolvedValue({ items: [makeAttachment()], nextCursor: null });
    renderSection();

    await screen.findByText('rack-diagram.pdf');
    expect(screen.queryByText(/showing the most recent/i)).not.toBeInTheDocument();
  });

  it('never requests before an org is resolved', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <AttachmentsSection companyId={null} entityType="article" entityId={ENTITY} />
      </QueryClientProvider>,
    );
    expect(apiFetch).not.toHaveBeenCalled();
  });
});
