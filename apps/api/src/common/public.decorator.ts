import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'is_public';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export const MFA_SETUP_ALLOWED_KEY = 'mfa_setup_allowed';
export const MfaSetupAllowed = () => SetMetadata(MFA_SETUP_ALLOWED_KEY, true);

export const SKIP_CSRF_KEY = 'skip_csrf';
export const SkipCsrf = () => SetMetadata(SKIP_CSRF_KEY, true);
