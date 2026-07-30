import { FileTile, FileTileGrid } from '../../components/FileTile';
import { SectionLabel } from '../../components/primitives';
import { ErrorBanner } from '../../components/states';
import { useAttachments } from './queries';
import type { AttachmentEntityType } from './api';

/**
 * The detail screens' Attachments block — desktop's `AttachmentsPanel`
 * read path, in mobile's tile vocabulary.
 *
 * Read-only by locked scope: list and open, no upload and no delete on
 * any of the three screens. That is a deliberate divergence from
 * desktop, where a writer can do both.
 *
 * Attachments are primary content, so this sits beside Related and
 * never inside a `ShowMore` — the runbook PDF or the photo of a wiring
 * closet is often the reason a tech opened the record at all.
 *
 * Owns its own query rather than taking data as a prop (the inverse of
 * `RelatedSection`, whose asset caller has to merge credentials in
 * first): there is nothing to fold in here, so each screen wires it in
 * one line. Callers render it only once the parent record has loaded,
 * which keeps a 404 deep link from firing an attachments request for
 * an id that can't exist.
 */
export function AttachmentsSection({
  companyId,
  entityType,
  entityId,
}: {
  companyId: string | null;
  entityType: AttachmentEntityType;
  entityId: string;
}) {
  const query = useAttachments(companyId, entityType, entityId);

  // A read that failed must not look like "no attachments" — that is
  // the exact silence this whole section exists to end. Pending and
  // genuinely-empty both render nothing, matching `RelatedSection`:
  // the section only earns its label when it has something to say.
  if (query.isError) {
    return (
      <section className="flex flex-col gap-2.25">
        <SectionLabel>Attachments</SectionLabel>
        <ErrorBanner
          title="Couldn’t load attachments."
          onRetry={() => void query.refetch()}
        />
      </section>
    );
  }

  const page = query.data;
  if (!page || page.items.length === 0) return null;

  return (
    <section className="flex flex-col gap-2.25">
      <SectionLabel>Attachments</SectionLabel>
      <FileTileGrid>
        {page.items.map((att) => (
          <FileTile
            key={att.id}
            filename={att.filename}
            sizeBytes={att.sizeBytes}
            isImage={att.isImage || att.mimeType.startsWith('image/')}
            thumbnailUrl={att.thumbnailUrl}
            href={att.downloadUrl}
          />
        ))}
      </FileTileGrid>
      {/* Desktop's panel silently shows only the first page too, but
          silently is the problem: a tech who can't find the file needs
          to know the list is cut, not conclude it isn't there. No
          "load more" — paging a section this rarely long isn't worth
          the control. */}
      {page.nextCursor !== null && (
        <p className="text-[13px] leading-snug text-muted">
          Showing the most recent {page.items.length}. Open this record on
          desktop to see the rest.
        </p>
      )}
    </section>
  );
}
