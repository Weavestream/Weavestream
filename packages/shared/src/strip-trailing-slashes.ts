/**
 * Remove every trailing `/` from a string.
 *
 * Deliberately a character scan, not `s.replace(/\/+$/, '')`: a backtracking
 * engine retries the unanchored `\/+` at every slash in the input, so a
 * long run of slashes that does not end the string costs O(n²) (CodeQL
 * js/polynomial-redos). This loop is O(n) on every input.
 */
export function stripTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 0x2f) end--;
  return end === s.length ? s : s.slice(0, end);
}
