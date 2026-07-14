import { CompanyPdfExportWorker } from './company-pdf-export.processor.js';
import type { CompanyExportData } from '../../../api/src/exports/company-export-data.service.js';
import { companyPdfTestFixture } from './company-pdf-export.test-fixture.js';

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

describe('CompanyPdfExportWorker reconstruction export compatibility', () => {
  it.each([false, true])(
    'passes includePasswords=%s through unchanged while rendering the complete dossier',
    async (includePasswords) => {
      const data = companyPdfTestFixture({ includePasswords });
      const storage = {
        exportKey: jest.fn().mockReturnValue('companies/c1/exports/export.pdf'),
        putObject: jest.fn().mockResolvedValue(undefined),
        getObjectBody: jest.fn(),
      };
      const audit = { log: jest.fn().mockResolvedValue(undefined) };
      const exportData = { gather: jest.fn().mockResolvedValue(data) };
      const crypto = { decrypt: jest.fn() };
      const worker = new CompanyPdfExportWorker(
        {} as never,
        storage as never,
        crypto as never,
        audit as never,
        exportData as never,
      );

      const result = await worker['handleExport'](
        { id: 'fixture-job' } as never,
        {
          kind: 'export',
          exportId: '00000000-0000-4000-8000-000000000099',
          companyId: data.company.id,
          includePasswords,
          pdfPasswordCiphertext: null,
        },
      );

      expect(exportData.gather).toHaveBeenCalledWith(data.company.id, { includePasswords });
      expect(crypto.decrypt).not.toHaveBeenCalled();
      expect(storage.putObject).toHaveBeenCalledWith(
        data.company.id,
        'companies/c1/exports/export.pdf',
        expect.any(Buffer),
        { contentType: 'application/pdf' },
      );
      expect(result.sizeBytes).toBeGreaterThan(1_000);
      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({
        after: expect.objectContaining({ includePasswords }),
      }));
    },
  );
});
