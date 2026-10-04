import type { UploadSummary } from '../../lib/server-api/uploads';

/** `UploadSummary` fixture for photo gallery tests. */
export function makePhoto(overrides: Partial<UploadSummary> = {}): UploadSummary {
  return {
    id: 'u1',
    companyId: 'c1',
    uploaderId: null,
    filename: 'rack.jpg',
    mimeType: 'image/jpeg',
    sizeBytes: 1024,
    isImage: true,
    width: 1600,
    height: 1200,
    attachedToType: 'asset',
    attachedToId: 'a1',
    createdAt: '2026-01-01T00:00:00Z',
    thumbnailUrl: '/api/v1/uploads/u1/thumb',
    downloadUrl: '/api/v1/uploads/u1/download',
    sourceArticle: null,
    articleLinkState: null,
    ...overrides,
  };
}
