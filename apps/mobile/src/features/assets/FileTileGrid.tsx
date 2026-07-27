import type { ReactNode } from 'react';
import { humanSize } from '@weavestream/shared/browser';
import { Icon } from '../../components/Icon';

/**
 * The FILE-field tile vocabulary, shared by the read path (detail
 * screen) and the editor (which composes progress/error/add tiles into
 * the same grid). A tile with an `href` is an anchor — long-press
 * preview and "open in new tab" should behave like a link; a tile
 * without one (deleted upload: the server hydrates `null` URLs but
 * keeps the entry) renders dimmed and inert, keeping the filename
 * visible rather than silently dropping the row.
 */

export function FileTileGrid({ children }: { children: ReactNode }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-2.5">
      {children}
    </div>
  );
}

export function FileTile({
  filename,
  sizeBytes,
  isImage,
  thumbnailUrl,
  href,
  overlay,
  action,
}: {
  filename: string;
  sizeBytes: number;
  isImage: boolean;
  thumbnailUrl: string | null;
  /** Same-origin download URL; null renders the tile dimmed and inert. */
  href: string | null;
  /** Covers the preview area (upload progress, error state). */
  overlay?: ReactNode;
  /** Top-right floating control (the editor's remove button). */
  action?: ReactNode;
}) {
  const preview = (
    <span className="relative flex aspect-square w-full items-center justify-center overflow-hidden rounded-tile bg-panel-2">
      {isImage && thumbnailUrl ? (
        <img
          src={thumbnailUrl}
          alt=""
          className="h-full w-full object-cover"
          loading="lazy"
        />
      ) : (
        <Icon name="description" size={28} className="text-muted" />
      )}
      {overlay}
    </span>
  );
  const caption = (
    <span className="flex flex-col">
      <span className="truncate text-meta font-medium text-text">{filename}</span>
      <span className="text-[12px] text-dim">{humanSize(sizeBytes)}</span>
    </span>
  );
  const boxClass = 'relative flex min-w-0 flex-col gap-1.5';

  if (href === null) {
    return (
      <div className={`${boxClass} opacity-60`}>
        {preview}
        {caption}
        {action}
      </div>
    );
  }
  return (
    <div className={boxClass}>
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`Open ${filename}`}
        className="flex min-w-0 flex-col gap-1.5"
      >
        {preview}
        {caption}
      </a>
      {action}
    </div>
  );
}
