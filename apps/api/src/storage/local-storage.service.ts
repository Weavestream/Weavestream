import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleInit,
  PayloadTooLargeException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, type ReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { resolveDataDir } from '@weavestream/shared/server';
import { EnvService } from '../config/env.service.js';

/**
 * Native local-filesystem storage backend.
 *
 * Replaces the previous MinIO/S3 implementation. Files live under a
 * single host-bind-mounted directory:
 *
 *   ${FILE_STORAGE_DIR}/<companyId>/uploads/<uploadId>/<safeFilename>
 *   ${FILE_STORAGE_DIR}/<companyId>/thumbs/<uploadId>.webp
 *   ${FILE_STORAGE_DIR}/<companyId>/exports/<exportId>.pdf
 *
 * Tenant isolation is by directory; the API still validates `companyId`
 * on every read/write, identical to the MinIO era. The browser never
 * touches the filesystem directly — every read/write goes through the
 * API's streaming endpoints.
 *
 * Public method shape mirrors the old `MinioService` so callers don't
 * change beyond the rename. `presignPut`/`presignGet` are gone — they
 * were unused on the live request path since v1.5.5.
 */
@Injectable()
export class LocalStorageService implements OnModuleInit {
  private readonly logger = new Logger(LocalStorageService.name);

  /** Resolved absolute root, computed once at construction. */
  private readonly root: string;

  constructor(private readonly env: EnvService) {
    this.root = resolveDataDir(this.env.values.FILE_STORAGE_DIR);
  }

  async onModuleInit(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
    this.logger.log(`Local storage configured (root=${this.root})`);
  }

  // ------------------------------------------------------------------
  // Tenant directory lifecycle
  // ------------------------------------------------------------------

  /**
   * Kept on the surface so call sites that previously primed a bucket
   * before handing back a relay URL don't change. For the local
   * backend this is just `mkdir -p ${root}/<companyId>`.
   */
  async ensureBucket(companyId: string): Promise<string> {
    this.assertSafeId(companyId, 'companyId');
    const dir = path.join(this.root, companyId);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  // ------------------------------------------------------------------
  // Object operations
  // ------------------------------------------------------------------

  /**
   * `fs.stat`-backed metadata lookup. Returns `null` on ENOENT so
   * callers can branch on missing objects the same way they did for an
   * S3 404.
   */
  async headObject(
    companyId: string,
    key: string,
  ): Promise<{
    ContentLength: number;
    LastModified: Date;
    ETag: string;
  } | null> {
    const abs = this.resolveKey(companyId, key);
    try {
      const stat = await fs.stat(abs);
      if (!stat.isFile()) return null;
      return {
        ContentLength: stat.size,
        LastModified: stat.mtime,
        ETag: etagFromStat(stat.size, stat.mtime),
      };
    } catch (err) {
      if (isEnoent(err)) return null;
      throw err;
    }
  }

  /**
   * Read a whole object into memory. Kept for callers that genuinely
   * need the full bytes in the heap (e.g. the worker embedding an image
   * into a generated PDF). The upload confirm path deliberately avoids
   * this in favour of {@link getObjectHead} + {@link getObjectStream} so
   * a large upload never lands in the heap.
   */
  async getObjectBody(companyId: string, key: string): Promise<Buffer> {
    const abs = this.resolveKey(companyId, key);
    return fs.readFile(abs);
  }

  /**
   * Read at most the first `maxBytes` of an object into a Buffer for
   * cheap magic-byte / BOM sniffing without loading the whole file into
   * the heap. Returns `null` on a missing / non-file key, mirroring
   * {@link getObjectStream}.
   */
  async getObjectHead(
    companyId: string,
    key: string,
    maxBytes: number,
  ): Promise<Buffer | null> {
    const abs = this.resolveKey(companyId, key);
    let stat;
    try {
      stat = await fs.stat(abs);
    } catch (err) {
      if (isEnoent(err)) return null;
      throw err;
    }
    if (!stat.isFile()) return null;
    if (maxBytes <= 0 || stat.size === 0) return Buffer.alloc(0);
    const end = Math.min(maxBytes, stat.size) - 1;
    const chunks: Buffer[] = [];
    for await (const chunk of createReadStream(abs, { start: 0, end })) {
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  }

  /**
   * Stream an object back to the caller without buffering. Used by
   * the upload `image` endpoint and the export download endpoint to
   * relay bytes to the browser. `contentType` is intentionally
   * undefined — callers already fall back to `Upload.mimeType` from
   * the database row.
   */
  async getObjectStream(
    companyId: string,
    key: string,
  ): Promise<{
    body: ReadStream;
    contentType?: string;
    contentLength?: number;
    lastModified?: Date;
    etag?: string;
  } | null> {
    const abs = this.resolveKey(companyId, key);
    let stat;
    try {
      stat = await fs.stat(abs);
    } catch (err) {
      if (isEnoent(err)) return null;
      throw err;
    }
    if (!stat.isFile()) return null;
    return {
      body: createReadStream(abs),
      contentLength: stat.size,
      lastModified: stat.mtime,
      etag: etagFromStat(stat.size, stat.mtime),
    };
  }

  /**
   * Resolve a stored object to its absolute on-disk path (no I/O).
   * Local backend only — exposed so callers can hand the path straight
   * to libraries that read files themselves (e.g. `sharp`), keeping
   * large media off the JS heap. Tenant containment is enforced by
   * {@link resolveKey}; existence is the caller's concern.
   */
  getObjectPath(companyId: string, key: string): string {
    return this.resolveKey(companyId, key);
  }

  /**
   * Atomic write: write to a `<key>.tmp-<rand>` sibling first, then
   * `fs.rename` into place. A crash mid-write leaves the temp file
   * behind (operator can prune) but never a partially written
   * production object. `contentType` is accepted for API parity and
   * ignored — the MIME type is stored in the `Upload` row.
   */
  async putObject(
    companyId: string,
    key: string,
    body: Buffer | Uint8Array,
    _opts: { contentType: string },
  ): Promise<void> {
    void _opts;
    const abs = this.resolveKey(companyId, key);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    const tmp = `${abs}.tmp-${randomBytes(8).toString('hex')}`;
    try {
      await fs.writeFile(tmp, body, { flag: 'wx' });
      await fs.rename(tmp, abs);
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    }
  }

  /**
   * Streaming counterpart to {@link putObject}. Pipes `source` straight
   * to a `<key>.tmp-<rand>` sibling and atomically renames it into
   * place, so the full body never lands in the JS heap. Enforces
   * `maxBytes` by counting bytes as they flow — it never trusts a
   * declared Content-Length — and tears the write down with the same
   * `PayloadTooLargeException` shape the old in-memory reader used. Any
   * failure removes the temp file.
   *
   * Byte-overflow surfaces as `PayloadTooLargeException`; filesystem and
   * write-stream errors bubble unchanged so the caller can map them to a
   * 5xx. Detecting a *client* abort is the caller's job (it owns the
   * request stream), so this method does not translate stream aborts.
   */
  async putObjectStream(
    companyId: string,
    key: string,
    source: Readable,
    opts: { contentType: string; maxBytes: number },
  ): Promise<void> {
    void opts.contentType;
    const abs = this.resolveKey(companyId, key);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    const tmp = `${abs}.tmp-${randomBytes(8).toString('hex')}`;
    let received = 0;
    const meter = new Transform({
      transform(chunk: Buffer | string, _enc, cb) {
        // Count actual bytes, not `String.length`: a Readable may emit
        // strings, and a multibyte character would otherwise undercount
        // against `maxBytes` (and write more bytes than we tallied).
        // Push the Buffer downstream so the write matches what we count.
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        received += buf.length;
        if (received > opts.maxBytes) {
          cb(
            new PayloadTooLargeException({
              error: 'FileTooLarge',
              sizeBytes: received,
              maxBytes: opts.maxBytes,
              message: `Upload body exceeds ${opts.maxBytes} bytes.`,
            }),
          );
          return;
        }
        cb(null, buf);
      },
    });
    try {
      await pipeline(source, meter, createWriteStream(tmp, { flags: 'wx' }));
      await fs.rename(tmp, abs);
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    }
  }

  async deleteObject(companyId: string, key: string): Promise<void> {
    const abs = this.resolveKey(companyId, key);
    try {
      await fs.rm(abs, { force: false });
    } catch (err) {
      if (isEnoent(err)) return;
      throw err;
    }
  }

  /**
   * Phase 7 reaper helper. After `deleteObject(uploadKey)` succeeds the
   * `${companyId}/uploads/<uploadId>/` directory is left empty; remove
   * it so we don't accumulate stale per-upload folders. Best-effort:
   * ENOENT (already gone) and ENOTEMPTY (somehow not empty — e.g. a
   * race with a fresh upload reusing the id, which shouldn't happen
   * because ids are UUIDs but better safe) are swallowed. Anything
   * else bubbles so the caller can decide whether to abort the row.
   */
  async removeUploadDirIfEmpty(companyId: string, uploadId: string): Promise<void> {
    this.assertSafeId(companyId, 'companyId');
    this.assertSafeId(uploadId, 'uploadId');
    const abs = path.join(this.root, companyId, 'uploads', uploadId);
    const tenantRoot = path.join(this.root, companyId);
    if (abs !== tenantRoot && !abs.startsWith(`${tenantRoot}${path.sep}`)) {
      throw new BadRequestException('Upload directory escapes tenant root');
    }
    try {
      await fs.rmdir(abs);
    } catch (err) {
      if (isEnoent(err) || isEnotEmpty(err)) return;
      throw err;
    }
  }

  // ------------------------------------------------------------------
  // Orphan-sweep enumeration (WS-013). Used only by the upload reaper
  // to find `${companyId}/uploads/<uploadId>/` directories whose bytes
  // were relayed but never confirmed. All three methods are strict
  // about shape: only UUID-named real directories count, symlinks are
  // never followed, and the recursive delete re-checks containment on
  // the resolved path right before removal.
  // ------------------------------------------------------------------

  /**
   * Company directories directly under the storage root. Returns only
   * UUID-shaped real directories — anything else under the root (temp
   * files, symlinks, operator debris) is ignored, never traversed.
   */
  async listTenantDirs(): Promise<string[]> {
    let entries;
    try {
      entries = await fs.readdir(this.root, { withFileTypes: true });
    } catch (err) {
      if (isEnoent(err)) return [];
      throw err;
    }
    return entries
      .filter((e) => e.isDirectory() && !e.isSymbolicLink() && isUuid(e.name))
      .map((e) => e.name);
  }

  /**
   * Per-upload directories under `${companyId}/uploads`, with the
   * directory mtime so the reaper can apply its minimum-age threshold.
   * Same shape rules as {@link listTenantDirs}; entries whose `lstat`
   * fails (raced away, or not actually a directory) are skipped.
   */
  async listUploadDirs(
    companyId: string,
  ): Promise<{ uploadId: string; mtime: Date }[]> {
    this.assertSafeId(companyId, 'companyId');
    if (!isUuid(companyId)) {
      throw new BadRequestException('companyId must be a UUID');
    }
    const uploadsRoot = path.join(this.root, companyId, 'uploads');
    let entries;
    try {
      entries = await fs.readdir(uploadsRoot, { withFileTypes: true });
    } catch (err) {
      if (isEnoent(err)) return [];
      throw err;
    }
    const out: { uploadId: string; mtime: Date }[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !isUuid(entry.name)) {
        continue;
      }
      try {
        const stat = await fs.lstat(path.join(uploadsRoot, entry.name));
        if (!stat.isDirectory()) continue;
        out.push({ uploadId: entry.name, mtime: stat.mtime });
      } catch (err) {
        if (isEnoent(err)) continue;
        throw err;
      }
    }
    return out;
  }

  /**
   * Recursively remove one upload directory (the orphaned file plus any
   * `.tmp-*` siblings a crashed relay left behind). Deliberately
   * stricter than {@link removeUploadDirIfEmpty} because it is the only
   * recursive delete in the service: both ids must be UUIDs, the target
   * must be a real directory (symlinks refused, never followed), and
   * the `realpath`-resolved location is re-checked against the tenant
   * root immediately before `fs.rm(recursive)`.
   */
  async removeUploadDir(companyId: string, uploadId: string): Promise<void> {
    this.assertSafeId(companyId, 'companyId');
    this.assertSafeId(uploadId, 'uploadId');
    if (!isUuid(companyId) || !isUuid(uploadId)) {
      throw new BadRequestException('companyId and uploadId must be UUIDs');
    }
    const abs = path.join(this.root, companyId, 'uploads', uploadId);

    let stat;
    try {
      stat = await fs.lstat(abs);
    } catch (err) {
      if (isEnoent(err)) return;
      throw err;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new BadRequestException('Upload directory is not a real directory');
    }

    // Containment on the *resolved* path: if any ancestor is a symlink
    // pointing outside the storage root, realpath exposes it and we
    // refuse rather than recursively delete foreign files.
    const tenantRoot = path.join(this.root, companyId);
    const resolved = await fs.realpath(abs);
    const resolvedTenantRoot = await fs.realpath(tenantRoot);
    if (
      resolved !== resolvedTenantRoot &&
      !resolved.startsWith(`${resolvedTenantRoot}${path.sep}`)
    ) {
      throw new BadRequestException('Upload directory escapes tenant root');
    }

    await fs.rm(abs, { recursive: true, force: true });
  }

  // ------------------------------------------------------------------
  // Key builders — single place to compute storage paths. Every path
  // starts with `<companyId>/…` so a key alone is enough to know which
  // tenant owns it.
  // ------------------------------------------------------------------

  uploadKey(companyId: string, uploadId: string, filename: string): string {
    const safe = filename.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 180);
    return `${companyId}/uploads/${uploadId}/${safe}`;
  }

  thumbnailKey(companyId: string, uploadId: string): string {
    return `${companyId}/thumbs/${uploadId}.webp`;
  }

  exportKey(companyId: string, exportId: string): string {
    return `${companyId}/exports/${exportId}.pdf`;
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

  /**
   * Resolve a `(companyId, key)` pair to an absolute filesystem path
   * and guarantee it stays inside `${this.root}/<companyId>`. The
   * controllers already build keys server-side, but defense in depth
   * is cheap here and prevents any future caller mistake from
   * escaping the tenant directory via `..` or an absolute key.
   */
  private resolveKey(companyId: string, key: string): string {
    this.assertSafeId(companyId, 'companyId');
    if (typeof key !== 'string' || key.length === 0) {
      throw new BadRequestException('Empty storage key');
    }
    if (key.includes('\0')) {
      throw new BadRequestException('Storage key contains null byte');
    }
    if (path.isAbsolute(key) || key.startsWith('/') || key.startsWith('\\')) {
      throw new BadRequestException('Storage key must be relative');
    }
    const tenantRoot = path.join(this.root, companyId);
    const abs = path.resolve(tenantRoot, this.stripTenantPrefix(companyId, key));
    if (abs !== tenantRoot && !abs.startsWith(`${tenantRoot}${path.sep}`)) {
      throw new BadRequestException('Storage key escapes tenant directory');
    }
    return abs;
  }

  /**
   * The legacy MinIO key builders prefixed every key with
   * `company/<companyId>/…` because S3 bucket scoping was per-tenant
   * and the prefix made keys self-describing. The new layout drops
   * the `company/` segment because the tenant id is already the first
   * directory under the root. Strip an inbound `<companyId>/` if a
   * caller still passes a fully qualified key (e.g. an `Upload.storageKey`
   * row written by the new builders).
   */
  private stripTenantPrefix(companyId: string, key: string): string {
    const prefix = `${companyId}/`;
    if (key.startsWith(prefix)) return key.slice(prefix.length);
    return key;
  }

  private assertSafeId(value: string, label: string): void {
    if (!value || typeof value !== 'string') {
      throw new BadRequestException(`Empty ${label}`);
    }
    if (value.includes('\0') || value.includes('/') || value.includes('\\') || value === '.' || value === '..') {
      throw new BadRequestException(`Unsafe ${label}`);
    }
  }
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: string }).code === 'ENOENT'
  );
}

function isEnotEmpty(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: string }).code;
  // Linux returns ENOTEMPTY; some macOS / BSD setups surface EEXIST for
  // a non-empty directory on `rmdir`.
  return code === 'ENOTEMPTY' || code === 'EEXIST';
}

/**
 * Cheap, stable ETag derived from size + mtime. Not a content hash —
 * we have `Upload.sha256` for that. Sufficient for the response header
 * the upload streaming controller sets so a client can validate
 * conditional requests against the same on-disk file.
 */
function etagFromStat(size: number, mtime: Date): string {
  const h = createHash('sha1');
  h.update(`${size}:${mtime.getTime()}`);
  return `"${h.digest('hex')}"`;
}
