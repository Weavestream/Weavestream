const sensitiveKeyPattern =
  /(secret|password|passwd|passphrase|token|apikey|authorization|credential|privatekey|encryptionkey|providerconfig|recoverykey|rawpayload|rawbody|rawrequest|rawresponse)/;

const sensitiveValuePatterns = [
  /\b(?:bearer|basic)\s+\S{8,}/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /(?:^|[?&;\s])(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|authorization)=\S+/i,
  /^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i,
  /\b(?:gh[pousr]_|xox[baprs]-|sk-(?:live-|test-)?)[A-Za-z0-9_-]{16,}\b/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
];

export function containsSensitiveMaterial(value: unknown): boolean {
  if (typeof value === 'string') {
    return sensitiveValuePatterns.some((pattern) => pattern.test(value)) || looksHighEntropy(value);
  }
  if (Array.isArray(value)) return value.some(containsSensitiveMaterial);
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).some(([key, entry]) => {
      const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
      return sensitiveKeyPattern.test(normalized) || containsSensitiveMaterial(entry);
    });
  }
  return false;
}

function looksHighEntropy(value: string): boolean {
  const candidate = value.trim();
  if (candidate.length < 40 || candidate.length > 4096 || /\s/.test(candidate)) return false;
  if (!/^[A-Za-z0-9+/_=-]+$/.test(candidate)) return false;
  const counts = new Map<string, number>();
  for (const char of candidate) counts.set(char, (counts.get(char) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / candidate.length;
    entropy -= probability * Math.log2(probability);
  }
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[+/_=-]/].filter((pattern) => pattern.test(candidate)).length;
  return classes >= 3 && entropy >= 4.25;
}
