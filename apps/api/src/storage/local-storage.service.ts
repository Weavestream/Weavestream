import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, type ReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
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

  async getObjectBody(companyId: string, key: string): Promise<Buffer> {
    const abs = this.resolveKey(companyId, key);
    return fs.readFile(abs);
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
