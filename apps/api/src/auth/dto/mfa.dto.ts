import { IsString, Matches } from 'class-validator';

// Accepts either a 6-digit TOTP code or a 10-character backup code
// (5+5 from the Crockford-style alphabet, optionally split with any
// mix of whitespace or dashes). The service layer normalises before
// hashing/comparing, but the DTO has to be permissive enough not to
// reject pasted codes that carry stray whitespace.
export class MfaVerifyDto {
  @IsString()
  @Matches(/^\s*(\d{6}|[2-9A-HJ-NP-Z]{5}[\s-]*[2-9A-HJ-NP-Z]{5})\s*$/i, {
    message: 'token must be a 6-digit code or backup code',
  })
  token!: string;
}
