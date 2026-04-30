import { Injectable } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { PasswordService } from './password.service.js';

const BACKUP_CODE_COUNT = 10;
const BACKUP_CODE_LENGTH = 10;
const BACKUP_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const BACKUP_CODE_PATTERN = /^[2-9A-HJ-NP-Z]{10}$/;

@Injectable()
export class MfaBackupCodeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
  ) {}

  async replaceForUser(userId: string): Promise<string[]> {
    const codes = Array.from({ length: BACKUP_CODE_COUNT }, () => this.generateCode());
    const hashes = await Promise.all(
      codes.map((code) => this.passwords.hash(normalizeBackupCode(code))),
    );

    await this.prisma.$transaction(async (tx) => {
      await tx.userMfaBackupCode.deleteMany({ where: { userId } });
      await tx.userMfaBackupCode.createMany({
        data: hashes.map((codeHash) => ({ userId, codeHash })),
      });
    });

    return codes;
  }

  async consume(userId: string, rawCode: string): Promise<boolean> {
    const code = normalizeBackupCode(rawCode);
    if (!BACKUP_CODE_PATTERN.test(code)) return false;

    const rows = await this.prisma.userMfaBackupCode.findMany({
      where: { userId, consumedAt: null },
      select: { id: true, codeHash: true },
      orderBy: { createdAt: 'asc' },
    });

    for (const row of rows) {
      if (!(await this.passwords.verify(row.codeHash, code))) continue;

      const result = await this.prisma.userMfaBackupCode.updateMany({
        where: { id: row.id, consumedAt: null },
        data: { consumedAt: new Date() },
      });
      return result.count === 1;
    }

    return false;
  }

  private generateCode(): string {
    let out = '';
    for (let i = 0; i < BACKUP_CODE_LENGTH; i += 1) {
      out += BACKUP_CODE_ALPHABET[randomInt(BACKUP_CODE_ALPHABET.length)];
    }
    return `${out.slice(0, 5)}-${out.slice(5)}`;
  }
}

export function normalizeBackupCode(code: string): string {
  return code.replace(/[\s-]+/g, '').toUpperCase();
}
