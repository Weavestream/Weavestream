import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const FORMAT_VERSION = 0x01;
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

  encrypt(plaintext: string): string {
    return this.encryptWith(plaintext, this.opts.activeKey, this.opts.activeKid);
  }

  decrypt(blob: string): string {
    const parsed = this.parseBlob(blob);
    return this.decryptParsed(parsed).toString('utf8');
  }

  reencryptIfStale(blob: string): { blob: string; rotated: boolean } {
    const parsed = this.parseBlob(blob);
    if (parsed.kid === this.opts.activeKid) {
      return { blob, rotated: false };
    }
    return {
      blob: this.encryptWith(
        this.decryptParsed(parsed).toString('utf8'),
        this.opts.activeKey,
        this.opts.activeKid,
      ),
      rotated: true,
    };
  }

  get currentKid(): string {
    return this.opts.activeKid;
  }

  private encryptWith(plaintext: string, key: Buffer, kid: string): string {
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv(ALGO, key, iv);
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

  private decryptParsed(parsed: ParsedBlob): Buffer {
    const decipher = createDecipheriv(ALGO, this.keyFor(parsed.kid), parsed.iv);
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
    if (version !== FORMAT_VERSION) {
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
      kid: buf.subarray(2, kidEnd).toString('utf8'),
      iv: buf.subarray(kidEnd, ivEnd),
      tag: buf.subarray(ivEnd, tagEnd),
      ciphertext: buf.subarray(tagEnd),
    };
  }
}

interface ParsedBlob {
  kid: string;
  iv: Buffer;
  tag: Buffer;
  ciphertext: Buffer;
}
