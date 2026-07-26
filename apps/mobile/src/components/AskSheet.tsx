import { Sheet } from './Sheet';
import { EmptyState } from './states';

/**
 * "Ask anything" — placeholder.
 *
 * The raised centre button is part of the tab bar's geometry, so it ships
 * in Phase 1 whether or not the panel behind it does. Rather than leave it
 * dead, it opens this: an honest statement that the feature is coming.
 *
 * Phase 3 replaces the body with the composer and transcript over the
 * existing SSE chat endpoint. The name is **"Ask anything"** — the design
 * handoff says "Ask Weave", and the product is never abbreviated to
 * "Weave" (CLAUDE.md).
 */
export function AskSheet({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Sheet open={open} onClose={onClose} title="Ask anything">
      <EmptyState message="Asking questions about this organization’s documentation is coming in a later release." />
    </Sheet>
  );
}
