import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { EnvService } from '../config/env.service.js';

export interface SetupTokenRecord {
  token: string;
  tokenHash: string;
  expiresAt: Date;
}

const TOKEN_BYTES = 32;
const TTL_HOURS = 24;

@Injectable()
export class SetupTokenService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly env: EnvService,
  ) {}

  static hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /**
   * Invalidates any existing unconsumed token for this user and mints a
   * fresh one. Returns the plaintext token (only ever visible here — the
   * DB stores the sha256).
   */
  async issue(
    userId: string,
    createdBy: string | null,
  ): Promise<{ token: string; expiresAt: Date; url: string }> {
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    const tokenHash = SetupTokenService.hash(token);
    const expiresAt = new Date(Date.now() + TTL_HOURS * 60 * 60 * 1000);

    await this.prisma.$transaction(async (tx) => {
      // Mark any outstanding tokens as consumed so a prior link stops
      // working the moment a new one is issued.
      await tx.userSetupToken.updateMany({
        where: { userId, consumedAt: null },
        data: { consumedAt: new Date() },
      });
      await tx.userSetupToken.create({
        data: {
          userId,
          tokenHash,
          expiresAt,
          createdBy,
        },
      });
    });

    const url = `${this.env.values.APP_URL.replace(/\/$/, '')}/setup/${token}`;
    return { token, expiresAt, url };
  }

  async lookup(token: string) {
    const hash = SetupTokenService.hash(token);
    const row = await this.prisma.userSetupToken.findUnique({
      where: { tokenHash: hash },
      include: {
        user: { select: { id: true, email: true, name: true, isActive: true } },
      },
    });
    if (!row) return null;
    const valid =
      row.consumedAt === null && row.expiresAt > new Date() && row.user.isActive;
    return { row, valid };
  }

  async consume(token: string) {
    const hash = SetupTokenService.hash(token);
    return this.prisma.userSetupToken.update({
      where: { tokenHash: hash },
      data: { consumedAt: new Date() },
    });
  }
}
