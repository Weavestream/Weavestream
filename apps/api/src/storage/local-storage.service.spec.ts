import { PayloadTooLargeException } from '@nestjs/common';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import { LocalStorageService } from './local-storage.service.js';

/**
 * Byte-level behavior of the streaming write + bounded reads lives here
 * (against a real temp directory), where the uploads service spec mocks
 * storage out. This is the enforcement point for the size ceiling and
 * the temp-file lifecycle.
 */
describe('LocalStorageService streaming + bounded reads', () => {
  let root: string;
  let svc: LocalStorageService;

  const cid = 'c1';
  const key = 'c1/uploads/u-1/a.bin';

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'local-storage-'));
    svc = new LocalStorageService({
      values: { FILE_STORAGE_DIR: root },
    } as never);
    await svc.onModuleInit();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function leftoverTemps(): Promise<string[]> {
    const dir = join(root, cid, 'uploads', 'u-1');
    const entries = await fs.readdir(dir).catch(() => [] as string[]);
    return entries.filter((e) => e.includes('.tmp-'));
  }

  const write = (source: Readable, maxBytes = 1024) =>
    svc.putObjectStream(cid, key, source, {
      contentType: 'application/octet-stream',
      maxBytes,
    });

  describe('putObjectStream', () => {
    it('writes the body atomically and leaves no temp file', async () => {
      const data = Buffer.from('hello world');
      await write(Readable.from(data));
      expect(await svc.getObjectHead(cid, key, 1024)).toEqual(data);
      expect(await leftoverTemps()).toEqual([]);
    });

    it('rejects an oversize stream, never creates the final object, and cleans the temp', async () => {
      const oversize = Buffer.alloc(2048, 7); // 2 KB > 1 KB cap
      await expect(write(Readable.from(oversize))).rejects.toBeInstanceOf(
        PayloadTooLargeException,
      );
      expect(await svc.getObjectHead(cid, key, 16)).toBeNull();
      expect(await leftoverTemps()).toEqual([]);
    });

    it('bubbles a source error unchanged and cleans the temp', async () => {
      const bad = new Readable({
        read() {
          this.destroy(new Error('source blew up'));
        },
      });
      await expect(write(bad)).rejects.toThrow('source blew up');
      expect(await svc.getObjectHead(cid, key, 16)).toBeNull();
      expect(await leftoverTemps()).toEqual([]);
    });

    it('writes a zero-byte object for an empty stream', async () => {
      await write(Readable.from(Buffer.alloc(0)));
      expect((await svc.headObject(cid, key))?.ContentLength).toBe(0);
    });

    it('enforces the ceiling by byte length for a multibyte string source', async () => {
      // '€€' is 2 characters but 6 UTF-8 bytes; the ceiling must count
      // bytes, not `String.length`, or an oversize body slips through.
      const src = Readable.from(['€€'], { objectMode: true });
      await expect(
        svc.putObjectStream(cid, key, src, {
          contentType: 'text/plain',
          maxBytes: 4,
        }),
      ).rejects.toBeInstanceOf(PayloadTooLargeException);
      expect(await svc.getObjectHead(cid, key, 16)).toBeNull();
      expect(await leftoverTemps()).toEqual([]);
    });

    it('writes a string source as its UTF-8 bytes', async () => {
      const src = Readable.from(['€'], { objectMode: true }); // 3 UTF-8 bytes
      await svc.putObjectStream(cid, key, src, {
        contentType: 'text/plain',
        maxBytes: 1024,
      });
      expect(await svc.getObjectHead(cid, key, 1024)).toEqual(
        Buffer.from('€', 'utf8'),
      );
    });
  });

  describe('getObjectHead', () => {
    it('returns only the first maxBytes', async () => {
      await write(Readable.from(Buffer.from('abcdefghij')));
      expect((await svc.getObjectHead(cid, key, 4))?.toString()).toBe('abcd');
    });

    it('returns the whole file when smaller than maxBytes', async () => {
      await write(Readable.from(Buffer.from('abc')));
      expect((await svc.getObjectHead(cid, key, 4096))?.toString()).toBe('abc');
    });

    it('returns null for a missing object', async () => {
      expect(await svc.getObjectHead(cid, 'c1/uploads/u-1/missing', 16)).toBeNull();
    });
  });

  describe('getObjectPath', () => {
    it('resolves inside the tenant root and can be read directly by sharp', async () => {
      const png = await sharp({
        create: {
          width: 8,
          height: 8,
          channels: 3,
          background: { r: 9, g: 9, b: 9 },
        },
      })
        .png()
        .toBuffer();
      const imgKey = 'c1/uploads/u-1/img.png';
      await svc.putObjectStream(cid, imgKey, Readable.from(png), {
        contentType: 'image/png',
        maxBytes: 1024 * 1024,
      });

      const p = svc.getObjectPath(cid, imgKey);
      expect(p.startsWith(join(root, cid))).toBe(true);

      // The confirm thumbnail path relies on sharp reading this path
      // directly (off-heap) instead of a full in-memory Buffer — prove
      // both metadata and a webp resize work from the path.
      expect((await sharp(p).metadata()).width).toBe(8);
      const thumb = await sharp(p).resize(4, 4).webp().toBuffer();
      expect(thumb.length).toBeGreaterThan(0);
    });

    it('rejects a key that escapes the tenant directory', () => {
      expect(() => svc.getObjectPath(cid, '../../etc/passwd')).toThrow();
    });
  });
});
