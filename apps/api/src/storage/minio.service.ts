import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import {
  S3Client,
  CreateBucketCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  PutBucketEncryptionCommand,
  PutPublicAccessBlockCommand,
  type HeadObjectCommandOutput,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { EnvService } from '../config/env.service.js';

/**
 * MinIO / S3 wrapper used by the Phase 4 upload pipeline.
 *
 * - One bucket per Company, created lazily on first upload and named
 *   `${MINIO_BUCKET_PREFIX}-<companyId>`.
 * - Server-side encryption (SSE-S3) is enforced at bucket creation.
 * - All presigned URLs carry a short TTL (default 5 minutes for PUT,
 *   60 seconds for GET) and are scoped to a key that starts with
 *   `company/<companyId>/…` — the UploadsService is the only caller and
 *   always computes the key itself, so the client never picks the path.
 *
 * As of v1.5.5 the browser never fetches from MinIO directly — every
 * thumbnail, attachment, logo, and export PDF is streamed through the
 * API on the same origin as the web app. `MINIO_PUBLIC_URL` is
 * therefore optional and only consulted when an operator explicitly
 * wants a presigned URL for an out-of-band consumer (a CLI tool, a
 * sibling service, etc.). When unset, the presigner falls back to the
 * internal endpoint so signed URLs still resolve from inside the
 * compose network.
 */
@Injectable()
export class MinioService implements OnModuleInit {
  private readonly logger = new Logger(MinioService.name);

  /** Internal client — used by the API for HEAD/PUT/GET/CreateBucket. */
  private readonly internal: S3Client;

  /** Presigning client — pinned to the browser-reachable origin. */
  private readonly presigner: S3Client;

  /** Cache of buckets we've verified/created this process lifetime. */
  private readonly ensured = new Set<string>();

  constructor(private readonly env: EnvService) {
    const { MINIO_ENDPOINT, MINIO_PORT, MINIO_USE_SSL, MINIO_REGION, MINIO_ACCESS_KEY, MINIO_SECRET_KEY, MINIO_PUBLIC_URL } =
      this.env.values;

    const protocol = MINIO_USE_SSL ? 'https' : 'http';
    const internalEndpoint = `${protocol}://${MINIO_ENDPOINT}:${MINIO_PORT}`;

    const creds = { accessKeyId: MINIO_ACCESS_KEY, secretAccessKey: MINIO_SECRET_KEY };

    this.internal = new S3Client({
      endpoint: internalEndpoint,
      region: MINIO_REGION,
      credentials: creds,
      forcePathStyle: true,
    });

    this.presigner = new S3Client({
      endpoint: MINIO_PUBLIC_URL ?? internalEndpoint,
      region: MINIO_REGION,
      credentials: creds,
      forcePathStyle: true,
    });
  }

  async onModuleInit(): Promise<void> {
    const publicLabel = this.env.values.MINIO_PUBLIC_URL ?? '<internal>';
    this.logger.log(
      `MinIO configured (internal=${this.env.values.MINIO_ENDPOINT}:${this.env.values.MINIO_PORT}, public=${publicLabel})`,
    );
  }

  // ------------------------------------------------------------------
  // Bucket lifecycle
  // ------------------------------------------------------------------

  bucketFor(companyId: string): string {
    return `${this.env.values.MINIO_BUCKET_PREFIX}-${companyId}`;
  }

  async ensureBucket(companyId: string): Promise<string> {
    const bucket = this.bucketFor(companyId);
    if (this.ensured.has(bucket)) return bucket;

    try {
      await this.internal.send(new HeadBucketCommand({ Bucket: bucket }));
      this.ensured.add(bucket);
      return bucket;
    } catch (err) {
      const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status !== 404 && status !== 301 && status !== 403) {
        throw err;
      }
    }

    try {
      await this.internal.send(new CreateBucketCommand({ Bucket: bucket }));
    } catch (err) {
      const name = (err as { name?: string }).name;
      if (name !== 'BucketAlreadyOwnedByYou' && name !== 'BucketAlreadyExists') {
        throw err;
      }
    }

    await this.internal
      .send(
        new PutBucketEncryptionCommand({
          Bucket: bucket,
          ServerSideEncryptionConfiguration: {
            Rules: [
              {
                ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' },
                BucketKeyEnabled: false,
              },
            ],
          },
        }),
      )
      .catch((err) => {
        this.logger.warn(
          `Could not set default encryption on bucket ${bucket}: ${(err as Error).message}`,
        );
      });

    await this.internal
      .send(
        new PutPublicAccessBlockCommand({
          Bucket: bucket,
          PublicAccessBlockConfiguration: {
            BlockPublicAcls: true,
            IgnorePublicAcls: true,
            BlockPublicPolicy: true,
            RestrictPublicBuckets: true,
          },
        }),
      )
      .catch((err) => {
        this.logger.warn(
          `Could not apply public-access block to bucket ${bucket}: ${(err as Error).message}`,
        );
      });

    this.ensured.add(bucket);
    return bucket;
  }

  // ------------------------------------------------------------------
  // Presigning
  // ------------------------------------------------------------------

  /**
   * Presign a PUT URL for a *specific* key the server computed. The
   * client never picks the key. Default TTL: 5 minutes.
   *
   * We deliberately only sign `ContentType` here. Anything else we pass
   * to `PutObjectCommand` gets added to the SigV4 signed-headers list,
   * which means the browser's subsequent PUT must send the exact same
   * header verbatim or MinIO / S3 will reject with 400
   * `SignatureDoesNotMatch`. `x-amz-server-side-encryption` and
   * `Content-Length` are the two we used to sign and that bit us:
   *   - The browser cannot set `x-amz-server-side-encryption`, so SSE
   *     must be enforced at the bucket level (see `ensureBucket` +
   *     `PutBucketEncryptionCommand`). On real S3 and MinIO-with-KES
   *     that works transparently; dev MinIO without a KMS skips it
   *     and stores objects unencrypted, which is acceptable locally.
   *   - `Content-Length` is set by the browser/XHR automatically, and
   *     we re-verify the stored size via `HeadObject` during confirm,
   *     so there's no need to enforce it in the signature.
   */
  async presignPut(
    companyId: string,
    key: string,
    opts: { contentType: string; ttlSeconds?: number },
  ): Promise<{ url: string; expiresAt: Date }> {
    const bucket = await this.ensureBucket(companyId);
    const ttl = opts.ttlSeconds ?? 300;
    const cmd = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ContentType: opts.contentType,
    });
    const url = await getSignedUrl(this.presigner, cmd, { expiresIn: ttl });
    return { url, expiresAt: new Date(Date.now() + ttl * 1000) };
  }

  async presignGet(
    companyId: string,
    key: string,
    opts: { ttlSeconds?: number; contentDisposition?: string } = {},
  ): Promise<{ url: string; expiresAt: Date }> {
    const bucket = this.bucketFor(companyId);
    const ttl = opts.ttlSeconds ?? 60;
    const cmd = new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      ...(opts.contentDisposition ? { ResponseContentDisposition: opts.contentDisposition } : {}),
    });
    const url = await getSignedUrl(this.presigner, cmd, { expiresIn: ttl });
    return { url, expiresAt: new Date(Date.now() + ttl * 1000) };
  }

  // ------------------------------------------------------------------
  // Direct object operations
  // ------------------------------------------------------------------

  async headObject(companyId: string, key: string): Promise<HeadObjectCommandOutput | null> {
    const bucket = this.bucketFor(companyId);
    try {
      return await this.internal.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    } catch (err) {
      const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404) return null;
      throw err;
    }
  }

  async getObjectBody(companyId: string, key: string): Promise<Buffer> {
    const bucket = this.bucketFor(companyId);
    const res = await this.internal.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!res.Body) throw new Error(`Empty body for ${bucket}/${key}`);
    const chunks: Buffer[] = [];
    for await (const chunk of res.Body as AsyncIterable<Uint8Array>) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  /**
   * Stream a stored object back to the caller without buffering. Used by
   * the upload `image` endpoint to relay article images to the browser
   * over the same origin, so MinIO can stay locked to the internal
   * Docker network. Returns the underlying stream plus the metadata the
   * controller needs to set response headers (Content-Type, Length,
   * Last-Modified, ETag).
   */
  async getObjectStream(
    companyId: string,
    key: string,
  ): Promise<{
    body: AsyncIterable<Uint8Array>;
    contentType?: string;
    contentLength?: number;
    lastModified?: Date;
    etag?: string;
  } | null> {
    const bucket = this.bucketFor(companyId);
    try {
      const res = await this.internal.send(
        new GetObjectCommand({ Bucket: bucket, Key: key }),
      );
      if (!res.Body) return null;
      return {
        body: res.Body as AsyncIterable<Uint8Array>,
        contentType: res.ContentType,
        contentLength: res.ContentLength,
        lastModified: res.LastModified,
        etag: res.ETag,
      };
    } catch (err) {
      const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata
        ?.httpStatusCode;
      if (status === 404) return null;
      throw err;
    }
  }

  async putObject(
    companyId: string,
    key: string,
    body: Buffer | Uint8Array,
    opts: { contentType: string },
  ): Promise<void> {
    const bucket = await this.ensureBucket(companyId);
    // Encryption is enforced at the bucket level (see `ensureBucket`).
    // Passing `ServerSideEncryption` here fails against dev MinIO without
    // a KMS/KES sidecar ("Server side encryption specified but KMS is
    // not configured"), which is what broke thumbnail generation — the
    // upload row would be created but `thumbnailKey` stayed null and the
    // FILE-field tiles rendered without a preview.
    await this.internal.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: opts.contentType,
      }),
    );
  }

  async deleteObject(companyId: string, key: string): Promise<void> {
    const bucket = this.bucketFor(companyId);
    await this.internal.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }

  // ------------------------------------------------------------------
  // Key builders — single place to compute storage paths. Every path
  // starts with `company/<companyId>/…` so an object key alone is enough
  // to know which tenant owns it.
  // ------------------------------------------------------------------

  uploadKey(companyId: string, uploadId: string, filename: string): string {
    const safe = filename.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 180);
    return `company/${companyId}/uploads/${uploadId}/${safe}`;
  }

  thumbnailKey(companyId: string, uploadId: string): string {
    return `company/${companyId}/thumbs/${uploadId}.webp`;
  }

  /**
   * Storage key for the company-export PDF feature. Lives under the
   * tenant prefix so the convention "an object key alone identifies
   * the tenant" is preserved alongside the per-bucket isolation.
   */
  exportKey(companyId: string, exportId: string): string {
    return `company/${companyId}/exports/${exportId}.pdf`;
  }
}
