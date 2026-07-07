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

/**
 * WS-013 orphan-sweep helpers. These are the only enumeration and
 * recursive-delete surfaces in the service, so the tests focus on the
 * strictness rules: UUID-shaped names only, symlinks refused/ignored,
 * resolved-path containment before the recursive rm.
 */
describe('LocalStorageService orphan-sweep helpers', () => {
  const COMPANY = '11111111-1111-1111-1111-111111111111';
  const UPLOAD = '22222222-2222-2222-2222-222222222222';

  let root: string;
  let outside: string;
  let svc: LocalStorageService;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'local-storage-orphan-'));
    outside = await fs.mkdtemp(join(tmpdir(), 'outside-root-'));
    svc = new LocalStorageService({
      values: { FILE_STORAGE_DIR: root },
    } as never);
    await svc.onModuleInit();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });

  async function makeUploadDir(
    companyId: string,
    uploadId: string,
    file = 'a.bin',
  ): Promise<string> {
    const dir = join(root, companyId, 'uploads', uploadId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, file), 'bytes');
    return dir;
  }

  describe('listTenantDirs', () => {
    it('returns only UUID-shaped real directories', async () => {
      await fs.mkdir(join(root, COMPANY));
      await fs.mkdir(join(root, 'not-a-uuid'));
      await fs.writeFile(join(root, `${UPLOAD}`), 'a file, not a dir');
      await fs.symlink(outside, join(root, '33333333-3333-3333-3333-333333333333'));
      expect(await svc.listTenantDirs()).toEqual([COMPANY]);
    });

    it('returns empty for a missing root', async () => {
      await fs.rm(root, { recursive: true, force: true });
      expect(await svc.listTenantDirs()).toEqual([]);
    });
  });

  describe('listUploadDirs', () => {
    it('lists UUID-shaped upload directories with their mtime', async () => {
      await makeUploadDir(COMPANY, UPLOAD);
      await fs.mkdir(join(root, COMPANY, 'uploads', 'temp-junk'), {
        recursive: true,
      });
      const rows = await svc.listUploadDirs(COMPANY);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.uploadId).toBe(UPLOAD);
      // Not `toBeInstanceOf(Date)`: fs Dates cross the jest ESM vm
      // realm boundary and fail instanceof despite being real Dates.
      expect(Number.isFinite(rows[0]!.mtime.getTime())).toBe(true);
    });

    it('ignores symlinked entries', async () => {
      await fs.mkdir(join(root, COMPANY, 'uploads'), { recursive: true });
      await fs.symlink(
        outside,
        join(root, COMPANY, 'uploads', '44444444-4444-4444-4444-444444444444'),
      );
      expect(await svc.listUploadDirs(COMPANY)).toEqual([]);
    });

    it('returns empty when the company has no uploads directory', async () => {
      expect(await svc.listUploadDirs(COMPANY)).toEqual([]);
    });

    it('rejects a non-UUID companyId', async () => {
      await expect(svc.listUploadDirs('not-a-uuid')).rejects.toThrow();
    });
  });

  describe('removeUploadDir', () => {
    it('recursively removes the directory including tmp siblings', async () => {
      const dir = await makeUploadDir(COMPANY, UPLOAD);
      await fs.writeFile(join(dir, 'a.bin.tmp-deadbeef'), 'partial');
      await svc.removeUploadDir(COMPANY, UPLOAD);
      await expect(fs.lstat(dir)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('is a no-op for a missing directory', async () => {
      await expect(
        svc.removeUploadDir(COMPANY, UPLOAD),
      ).resolves.toBeUndefined();
    });

    it('rejects non-UUID ids', async () => {
      await expect(svc.removeUploadDir('c1', UPLOAD)).rejects.toThrow();
      await expect(svc.removeUploadDir(COMPANY, 'u-1')).rejects.toThrow();
    });

    it('refuses a symlinked upload directory and leaves the target intact', async () => {
      const victim = join(outside, 'victim');
      await fs.mkdir(victim);
      await fs.writeFile(join(victim, 'keep.txt'), 'precious');
      await fs.mkdir(join(root, COMPANY, 'uploads'), { recursive: true });
      await fs.symlink(victim, join(root, COMPANY, 'uploads', UPLOAD));

      await expect(svc.removeUploadDir(COMPANY, UPLOAD)).rejects.toThrow();
      expect(await fs.readFile(join(victim, 'keep.txt'), 'utf8')).toBe(
        'precious',
      );
    });

    it('refuses when an ancestor symlink escapes the tenant root', async () => {
      // uploads/ itself is a symlink pointing outside the storage root;
      // the realpath containment check must catch it.
      const victimUploads = join(outside, 'uploads');
      await fs.mkdir(join(victimUploads, UPLOAD), { recursive: true });
      await fs.writeFile(join(victimUploads, UPLOAD, 'keep.txt'), 'precious');
      await fs.mkdir(join(root, COMPANY), { recursive: true });
      await fs.symlink(victimUploads, join(root, COMPANY, 'uploads'));

      await expect(svc.removeUploadDir(COMPANY, UPLOAD)).rejects.toThrow();
      expect(
        await fs.readFile(join(victimUploads, UPLOAD, 'keep.txt'), 'utf8'),
      ).toBe('precious');
    });
  });
});
