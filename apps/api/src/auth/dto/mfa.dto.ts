import { IsString, Matches } from 'class-validator';

export class MfaVerifyDto {
  @IsString()
  @Matches(/^\d{6}$/, { message: 'token must be 6 digits' })
  token!: string;
}
