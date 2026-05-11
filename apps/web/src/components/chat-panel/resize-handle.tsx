'use client';

import { useEffect, useRef, type CSSProperties } from 'react';
import { useChatPanel } from './chat-panel-provider';

/**
 * 4px-wide drag handle pinned to the left edge of the chat panel.
 * Width is computed as `window.innerWidth - clientX` and is clamped to
 * MIN_WIDTH/MAX_WIDTH by the provider's `setWidth` reducer. Disables
 * text selection while dragging so the cursor doesn't accidentally
 * select main-content text.
 */
export function ResizeHandle() {
  const { setWidth } = useChatPanel();
  const draggingRef = useRef(false);

  useEffect(() => {
    function onMove(e: PointerEvent) {
      if (!draggingRef.current) return;
      setWidth(window.innerWidth - e.clientX);
    }
    function onUp() {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [setWidth]);

  const style: CSSProperties = {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: -2,
    width: 6,
    cursor: 'col-resize',
    zIndex: 2,
    background: 'transparent',
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize chat panel"
      style={style}
      onPointerDown={(e) => {
        e.preventDefault();
        draggingRef.current = true;
        document.body.style.userSelect = 'none';
        document.body.style.cursor = 'col-resize';
      }}
    />
  );
}
