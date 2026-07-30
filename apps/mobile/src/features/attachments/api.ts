import { apiFetch } from '../../lib/api';

/**
 * Entity-level attachments — the files a user hung on an asset,
 * article, or password from desktop's Attachments panel.
 *
 * **Not the same thing as an asset FILE field.** Those are
 * customer-defined layout fields whose value is an array of upload
 * entries, hydrated inline on the asset record and rendered by
 * `FieldValueDisplay`. These are `Upload` rows carrying
 * `attachedToType`/`attachedToId`, and until now mobile never asked
 * for them — which is why the detail screens showed linked items but
 * no files.
 *
 * Lives in its own feature folder for the same reason `relations`
 * does: all three detail screens render it, and features must not
 * import from each other.
 *
 * Mobile is read-only here (locked scope): list and open. Upload and
 * delete stay desktop work, so nothing in this folder mutates.
 */

/**
 * The attachable entity kinds mobile has detail screens for. The wire
 * enum (`uploadAttachmentTypeSchema`) also has `asset_field`, which is
 * deliberately absent — those rows belong to a layout field's value
 * and are rendered there, never in this section.
 */
export type AttachmentEntityType = 'asset' | 'article' | 'password';

/**
 * Minimal wire slice of the server's `SerializedUpload` — same local
 * -interface precedent as `RelatedItem`. `sha256`, `width`/`height`,
 * `uploaderId`, and the article link-state fields are all sent and all
 * unused here: a tile shows a thumbnail, a name, and a size.
 *
 * `downloadUrl`/`thumbnailUrl` are same-origin `/api/v1/...` paths
 * minted by the server (never user-stored strings), so they go
 * straight into `href`/`src` — the `safeProseHref` gate that guards
 * article bodies has nothing to do here.
 */
export interface Attachment {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  isImage: boolean;
  thumbnailUrl: string | null;
  downloadUrl: string | null;
  createdAt: string;
}

export interface AttachmentPage {
  items: Attachment[];
  /** Non-null = the server had more than one page. See `AttachmentsSection`. */
  nextCursor: string | null;
}

export async function fetchAttachments(
  companyId: string,
  entityType: AttachmentEntityType,
  entityId: string,
): Promise<AttachmentPage> {
  // Both filters are required — the endpoint refuses a tenant-wide
  // dump. Authorization is re-derived server-side from the session
  // (`upload.read` on the company); the entity ids in this URL are a
  // filter, never a claim.
  const res = await apiFetch<{ items?: Attachment[]; nextCursor?: string | null }>(
    `/companies/${companyId}/uploads` +
      `?attachedToType=${entityType}` +
      `&attachedToId=${encodeURIComponent(entityId)}`,
  );
  return {
    items: res.items ?? [],
    nextCursor: res.nextCursor ?? null,
  };
}
