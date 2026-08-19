/**
 * Human-readable byte sizes: `900 B`, `1.2 KB`, `3.4 MB`, `1.25 GB`.
 *
 * Base-1024, with the precision fixed per magnitude — one decimal up to MB,
 * two at GB — so a size caption never jitters in width as the value changes.
 *
 * Lives in the client-safe barrel, not `browser/`, because it touches no DOM
 * API and is rendered from React Server Components (the asset detail pages)
 * as well as client components and `apps/mobile`. It sat in
 * `browser/upload-client.ts` until an RSC needed it, which is exactly the
 * import that barrel's header forbids.
 *
 * The TB-capable `formatBytes` (backups, exports, the RMM drivers) and the
 * variable-precision `humanBytes` (tickets) round differently and are
 * deliberately NOT folded in here.
 */
export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
