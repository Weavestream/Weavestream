import { CompanyPdfExportWorker } from './company-pdf-export.processor.js';
import type { CompanyExportData } from '../../../api/src/exports/company-export-data.service.js';

/**
 * WS-027: pdfkit fully decodes whatever buffer it is handed, so the
 * security-critical property is that images blocked by the size gate never
 * have their bytes read off disk in the first place. This drives the real
 * (private) hydration pass with a mocked storage layer and asserts exactly
 * which rows reach `getObjectBody`.
 */
describe('CompanyPdfExportWorker.hydrateArticleImages (WS-027 size gate)', () => {
  function makeImage(over: {
    uploadId: string;
    mimeType?: string;
    width: number | null;
    height: number | null;
  }) {
    return {
      uploadId: over.uploadId,
      filename: `${over.uploadId}.png`,
      mimeType: over.mimeType ?? 'image/png',
      storageKey: `c1/uploads/${over.uploadId}/f`,
      width: over.width,
      height: over.height,
    };
  }

  it('reads bytes only for embeddable images within the pixel cap', async () => {
    const withinCap = makeImage({ uploadId: 'ok', width: 4000, height: 3000 });
    const oversized = makeImage({ uploadId: 'bomb', width: 16000, height: 16000 });
    const nullDims = makeImage({ uploadId: 'nodims', width: null, height: null });
    const wrongMime = makeImage({
      uploadId: 'gif',
      mimeType: 'image/gif',
      width: 100,
      height: 100,
    });
    const data = {
      articles: [{ images: [withinCap, oversized, nullDims, wrongMime] }],
    } as unknown as CompanyExportData;

    const getObjectBody = jest.fn().mockResolvedValue(Buffer.from('pixels'));
    const worker = new CompanyPdfExportWorker(
      {} as never,
      { getObjectBody } as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await worker['hydrateArticleImages']('c1', data);

    expect(getObjectBody).toHaveBeenCalledTimes(1);
    expect(getObjectBody).toHaveBeenCalledWith('c1', withinCap.storageKey);
    const images = data.articles[0].images;
    expect(images[0].data).toEqual(Buffer.from('pixels'));
    expect(images[1].data).toBeUndefined();
    expect(images[2].data).toBeUndefined();
    expect(images[3].data).toBeUndefined();
  });
});
