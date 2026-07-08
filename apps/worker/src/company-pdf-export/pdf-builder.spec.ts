import {
  articleSegmentsFromTiptap,
  formatAssetFieldValue,
  pdfEmbedSizeBlockReason,
  richTextToPlaintext,
} from './pdf-builder.js';

const COMPANY_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const UPLOAD_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

describe('PDF export formatting helpers', () => {
  it('resolves asset reference UUIDs to names', () => {
    expect(
      formatAssetFieldValue({
        label: 'Parent',
        fieldType: 'ASSET_REFERENCE',
        value: [UPLOAD_ID, 'cccccccc-cccc-cccc-cccc-cccccccccccc'],
        referenceLabels: { [UPLOAD_ID]: 'Primary firewall' },
      }),
    ).toBe('Primary firewall, cccccccc-cccc-cccc-cccc-cccccccccccc');
  });

  it('resolves TAGS UUIDs to tag names', () => {
    const TAG_A = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
    const TAG_B = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
    expect(
      formatAssetFieldValue({
        label: 'Tags',
        fieldType: 'TAGS',
        value: [TAG_A, TAG_B],
        referenceLabels: { [TAG_A]: 'Production', [TAG_B]: 'Critical' },
      }),
    ).toBe('Production, Critical');
  });

  it('flattens rich text docs instead of stringifying JSON', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Connect through the VPN.' }],
        },
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Then open RDP.' }],
        },
      ],
    };

    expect(richTextToPlaintext(doc)).toBe('Connect through the VPN.\nThen open RDP.');
    expect(richTextToPlaintext({ v: doc })).toBe(
      'Connect through the VPN.\nThen open RDP.',
    );
  });

  it('turns Tiptap image nodes into image segments, not filename text', () => {
    const segments = articleSegmentsFromTiptap({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Before image' }],
        },
        {
          type: 'image',
          attrs: {
            src: `/api/v1/companies/${COMPANY_ID}/uploads/${UPLOAD_ID}/image`,
            alt: '94a9686619cabcaa31ab5d59308af037.png',
          },
        },
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'After image' }],
        },
      ],
    });

    expect(segments).toEqual([
      { kind: 'text', text: 'Before image\n' },
      {
        kind: 'image',
        uploadId: UPLOAD_ID,
        fallbackLabel: '94a9686619cabcaa31ab5d59308af037.png',
      },
      { kind: 'text', text: 'After image\n' },
    ]);
  });
});

describe('pdfEmbedSizeBlockReason (WS-027 decompression-bomb gate)', () => {
  it('blocks images above the pixel cap', () => {
    expect(pdfEmbedSizeBlockReason(10000, 6000)).toBe('image too large to embed');
  });

  it('allows images at exactly the pixel cap (strict >)', () => {
    expect(pdfEmbedSizeBlockReason(10000, 5000)).toBeNull();
  });

  it('fails closed on unknown dimensions', () => {
    expect(pdfEmbedSizeBlockReason(null, null)).toBe('image dimensions unavailable');
    expect(pdfEmbedSizeBlockReason(1000, null)).toBe('image dimensions unavailable');
    expect(pdfEmbedSizeBlockReason(undefined, 1000)).toBe('image dimensions unavailable');
  });

  it('allows ordinary photo dimensions', () => {
    expect(pdfEmbedSizeBlockReason(8000, 6000)).toBeNull();
  });
});
