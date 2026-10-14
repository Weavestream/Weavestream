/**
 * A password change and "sign out other sessions" revoke every API key and
 * AI connection the user holds. Counts are `null` when the list failed to
 * load: unknown, so the warning shows anyway.
 */
export function shouldWarnOfRevocation(apiKeyCount: number | null, connectionCount: number | null): boolean {
  return apiKeyCount !== 0 || connectionCount !== 0;
}

/** "You have 2 API keys and 1 AI connection." — only the known, non-zero counts. */
export function revocationCountSentence(apiKeyCount: number | null, connectionCount: number | null): string {
  const parts: string[] = [];
  if (apiKeyCount) parts.push(`${apiKeyCount} API key${apiKeyCount === 1 ? '' : 's'}`);
  if (connectionCount) parts.push(`${connectionCount} AI connection${connectionCount === 1 ? '' : 's'}`);
  return parts.length ? `You have ${parts.join(' and ')}.` : '';
}
