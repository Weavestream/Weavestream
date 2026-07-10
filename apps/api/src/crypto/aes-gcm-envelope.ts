import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';
/**
 * 0x01 blobs predate AAD binding: the GCM tag authenticates only the
 * ciphertext, so a blob can be relocated to another row/tenant and still
 * decrypt. Accepted on decrypt for migration; never written anymore.
 */
const LEGACY_VERSION = 0x01;
/** 0x02 blobs bind the record identity (AAD) into the GCM tag. */
const FORMAT_VERSION = 0x02;
const IV_LEN = 12;
const TAG_LEN = 16;
const MAX_KID_LEN = 255;

export type PreviousEnvelopeKey = { kid: string; key: Buffer };

export class AesGcmEnvelope {
  private readonly previousKeys: Map<string, Buffer>;

  constructor(
    private readonly opts: {
      activeKey: Buffer;
      activeKid: string;
      previousKeys: PreviousEnvelopeKey[];
      keyLabel: string;
      previousKeysLabel: string;
      blobLabel: string;
    },
  ) {
    if (opts.activeKey.length !== 32) {
      throw new Error(`${opts.keyLabel} must decode to exactly 32 bytes`);
    }
    if (Buffer.byteLength(opts.activeKid, 'utf8') > MAX_KID_LEN) {
      throw new Error(
        `${opts.keyLabel}_KID must be <= ${MAX_KID_LEN} bytes when UTF-8 encoded`,
      );
    }

    this.previousKeys = new Map();
    for (const { kid, key } of opts.previousKeys) {
      if (key.length !== 32) {
        throw new Error(`${opts.previousKeysLabel} entry "${kid}" must be 32 bytes`);
      }
      if (kid === opts.activeKid) {
        throw new Error(
          `${opts.previousKeysLabel} must not reuse the active kid ("${kid}")`,
        );
      }
      this.previousKeys.set(kid, key);
    }
  }

  /**
   * `aad` is the record identity the ciphertext is bound to (e.g.
   * `password:{companyId}:{passwordId}:totp`). It is authenticated into
   * the GCM tag, so decrypting under a different identity fails — a blob
   * copied to another row/tenant/field no longer decrypts. It must be
   * stable for the lifetime of the record and identical on decrypt.
   */
  encrypt(plaintext: string, aad: string): string {
    return this.encryptWith(
      plaintext,
      this.opts.activeKey,
      this.opts.activeKid,
      aad,
    );
  }

  decrypt(blob: string, aad: string): string {
    const parsed = this.parseBlob(blob);
    return this.decryptParsed(parsed, aad).toString('utf8');
  }

  /**
   * Rewraps when the blob is on a stale kid OR still in the legacy
   * pre-AAD format, so one re-encrypt pass both rotates keys and binds
   * every blob to its record identity.
   */
  reencryptIfStale(blob: string, aad: string): { blob: string; rotated: boolean } {
    const parsed = this.parseBlob(blob);
    if (parsed.kid === this.opts.activeKid && parsed.version === FORMAT_VERSION) {
      return { blob, rotated: false };
    }
    return {
      blob: this.encryptWith(
        this.decryptParsed(parsed, aad).toString('utf8'),
        this.opts.activeKey,
        this.opts.activeKid,
        aad,
      ),
      rotated: true,
    };
  }

  get currentKid(): string {
    return this.opts.activeKid;
  }

  private encryptWith(
    plaintext: string,
    key: Buffer,
    kid: string,
    aad: string,
  ): string {
    if (aad.length === 0) {
      // Empty AAD is indistinguishable from no AAD in GCM — it would
      // silently produce an unbound blob while looking bound at the
      // call site.
      throw new Error(`${this.opts.blobLabel} AAD must be non-empty`);
    }
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv(ALGO, key, iv);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    const kidBuf = Buffer.from(kid, 'utf8');
    return Buffer.concat([
      Buffer.from([FORMAT_VERSION]),
      Buffer.from([kidBuf.length]),
      kidBuf,
      iv,
      tag,
      enc,
    ]).toString('base64');
  }

  private decryptParsed(parsed: ParsedBlob, aad: string): Buffer {
    const decipher = createDecipheriv(ALGO, this.keyFor(parsed.kid), parsed.iv);
    // Legacy 0x01 blobs were sealed without AAD; feeding one would fail
    // the tag check on every un-migrated record. They stay decryptable
    // (unbound, as written) until reencryptIfStale/the CLI rewraps them.
    if (parsed.version === FORMAT_VERSION) {
      decipher.setAAD(Buffer.from(aad, 'utf8'));
    }
    decipher.setAuthTag(parsed.tag);
    return Buffer.concat([
      decipher.update(parsed.ciphertext),
      decipher.final(),
    ]);
  }

  private keyFor(kid: string): Buffer {
    if (kid === this.opts.activeKid) return this.opts.activeKey;
    const prev = this.previousKeys.get(kid);
    if (!prev) throw new Error(`unknown ${this.opts.blobLabel} kid "${kid}"`);
    return prev;
  }

  private parseBlob(blob: string): ParsedBlob {
    let buf: Buffer;
    try {
      buf = Buffer.from(blob, 'base64');
    } catch {
      throw new Error(`${this.opts.blobLabel} blob is not valid base64`);
    }
    if (buf.length < 2 + 1 + IV_LEN + TAG_LEN) {
      throw new Error(`${this.opts.blobLabel} blob is truncated`);
    }
    const version = buf.readUInt8(0);
    if (version !== FORMAT_VERSION && version !== LEGACY_VERSION) {
      throw new Error(
        `unsupported ${this.opts.blobLabel} blob version 0x${version.toString(16)}`,
      );
    }
    const kidLen = buf.readUInt8(1);
    if (kidLen === 0) {
      throw new Error(`${this.opts.blobLabel} blob has empty kid`);
    }
    const kidEnd = 2 + kidLen;
    if (buf.length < kidEnd + IV_LEN + TAG_LEN) {
      throw new Error(`${this.opts.blobLabel} blob is truncated`);
    }
    const ivEnd = kidEnd + IV_LEN;
    const tagEnd = ivEnd + TAG_LEN;
    return {
      version,
      kid: buf.subarray(2, kidEnd).toString('utf8'),
      iv: buf.subarray(kidEnd, ivEnd),
      tag: buf.subarray(ivEnd, tagEnd),
      ciphertext: buf.subarray(tagEnd),
    };
  }
}

interface ParsedBlob {
  version: number;
  kid: string;
  iv: Buffer;
  tag: Buffer;
  ciphertext: Buffer;
}
