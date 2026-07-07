/**
 * Redis keys for the pending-upload session (init → relay PUT →
 * confirm). Shared between `UploadsService`, which owns the session
 * lifecycle, and the worker's upload reaper, which checks for a live
 * session before removing an orphaned upload directory (WS-013).
 */
export function pendingKey(uploadId: string): string {
  return `upload:pending:${uploadId}`;
}

/**
 * Marks that an upload session's body has been (or is being) written.
 * `SET NX` on this key is the write-once guard: the first relay PUT
 * claims it and later PUTs are rejected, so the bytes `confirm`
 * validates can't be swapped underneath it.
 */
export function bodyKey(uploadId: string): string {
  return `upload:body:${uploadId}`;
}
