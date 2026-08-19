'use client';

import { useState } from 'react';
import {
  Btn,
  Icon,
  LinkBtn,
  MenuDivider,
  MenuItem,
  OverflowMenu,
  StarGlyph,
  Tag,
  useStarToggle,
} from '../../../../../../components/ui';
import { useArticleArchive } from '../article-actions';
import { HistoryPanel } from './history-panel';

/**
 * The article read view's whole action cluster, rendered into
 * `TopBar`'s `right` slot.
 *
 * This replaces the 50px sub-row that used to carry five equal-weight
 * buttons (Star, History, Edit, Archive, New article). What is left in
 * the row is the one action a reader came for — Edit, or Restore when
 * the article is archived and Edit does not apply — plus the overflow
 * menu holding the rest.
 *
 * Star lives in the menu deliberately: the global cluster two icons to
 * the right already carries a star for *starred items*, and two stars
 * in one header is a coin toss.
 *
 * A draft in progress used to be a warn `Tag` in the row. It is now the
 * attention dot on the overflow trigger plus a tag on the History row,
 * which is the same contract `ShowMore` follows — collapsing must never
 * bury something that needs review.
 */
export function ArticleHeaderActions({
  companyId,
  article,
  manage,
}: {
  companyId: string;
  article: {
    id: string;
    title: string;
    archivedAt: string | null;
    folderId: string | null;
    isStarred: boolean;
    hasDraft: boolean;
  };
  /** Write access to this company, derived server-side. */
  manage: boolean;
}) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const { starred, toggle } = useStarToggle({
    entityType: 'article',
    entityId: article.id,
    initialStarred: article.isStarred,
  });
  const { archived, requestArchiveToggle, requestPurge, dialogs } =
    useArticleArchive({
      article: {
        id: article.id,
        companyId,
        title: article.title,
        archivedAt: article.archivedAt,
      },
    });

  const base = `/admin/companies/${companyId}/articles`;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      {manage &&
        (archived ? (
          // Edit is unavailable while archived, so the primary slot
          // carries the action that makes it available again rather
          // than sitting empty.
          <Btn
            kind="solid"
            size="md"
            icon={Icon.check}
            onClick={requestArchiveToggle}
          >
            Restore
          </Btn>
        ) : (
          <LinkBtn
            href={`${base}/${article.id}/edit`}
            kind="outline"
            size="md"
            icon={<Icon.edit size={13} />}
          >
            Edit
          </LinkBtn>
        ))}

      <OverflowMenu attention={article.hasDraft ? 'warn' : undefined}>
        {(close) => (
          <>
            <MenuItem
              glyph={<StarGlyph filled={starred} size={14} />}
              onClick={() => {
                void toggle();
              }}
            >
              {starred ? 'Starred' : 'Star'}
            </MenuItem>
            <MenuItem
              icon={Icon.clock}
              trailing={
                article.hasDraft ? <Tag tone="warn">draft</Tag> : undefined
              }
              onClick={() => {
                setHistoryOpen(true);
                close();
              }}
            >
              History
            </MenuItem>
            {manage && (
              <MenuItem
                icon={Icon.plus}
                href={`${base}/new${article.folderId ? `?folderId=${article.folderId}` : ''}`}
                onClick={close}
              >
                New article
              </MenuItem>
            )}
            {manage && <MenuDivider />}
            {manage && !archived && (
              <MenuItem
                icon={Icon.archive}
                onClick={() => {
                  requestArchiveToggle();
                  close();
                }}
              >
                Archive
              </MenuItem>
            )}
            {manage && archived && (
              <MenuItem
                icon={Icon.trash}
                tone="danger"
                onClick={() => {
                  requestPurge();
                  close();
                }}
              >
                Delete forever
              </MenuItem>
            )}
          </>
        )}
      </OverflowMenu>

      <HistoryPanel
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        companyId={companyId}
        articleId={article.id}
        hasDraft={article.hasDraft}
        // Restore is only meaningful when the article is editable.
        // Archived articles still expose the history list (compliance
        // reads), but the restore action is locked behind unarchive.
        canRestore={manage && !archived}
      />
      {dialogs}
    </div>
  );
}
