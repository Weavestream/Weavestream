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

const MAX_SCAN_DEPTH = 8;
const MAX_SCAN_ENTRIES = 1_024;

export type SensitiveMaterialScan = 'safe' | 'sensitive' | 'bounds_exceeded';

export function scanSensitiveMaterial(root: unknown): SensitiveMaterialScan {
  const pending: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  const seen = new WeakSet<object>();
  let entries = 0;

  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.depth > MAX_SCAN_DEPTH) return 'bounds_exceeded';
    if (typeof current.value === 'string') {
      const text = current.value;
      if (sensitiveValuePatterns.some((pattern) => pattern.test(text)) || looksHighEntropy(text)) {
        return 'sensitive';
      }
      continue;
    }
    if (!current.value || typeof current.value !== 'object') continue;
    if (seen.has(current.value)) return 'bounds_exceeded';
    seen.add(current.value);

    if (Array.isArray(current.value)) {
      entries += current.value.length;
      if (entries > MAX_SCAN_ENTRIES) return 'bounds_exceeded';
      for (let index = 0; index < current.value.length; index += 1) {
        if (index in current.value) {
          pending.push({ value: current.value[index], depth: current.depth + 1 });
        }
      }
      continue;
    }

    try {
      for (const key in current.value) {
        if (!Object.prototype.hasOwnProperty.call(current.value, key)) continue;
        entries += 1;
        if (entries > MAX_SCAN_ENTRIES) return 'bounds_exceeded';
        const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
        if (sensitiveKeyPattern.test(normalized)) return 'sensitive';
        pending.push({
          value: (current.value as Record<string, unknown>)[key],
          depth: current.depth + 1,
        });
      }
    } catch {
      return 'bounds_exceeded';
    }
  }
  return 'safe';
}

export function containsSensitiveMaterial(value: unknown): boolean {
  return scanSensitiveMaterial(value) !== 'safe';
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
