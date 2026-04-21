import TiptapImage from '@tiptap/extension-image';

/**
 * Extends Tiptap's stock `Image` node with:
 *   1. A persisted `width` attribute (round-trips through HTML + JSON).
 *   2. A vanilla-DOM NodeView that renders a drag handle in the
 *      bottom-right corner for interactive resizing. The handle only
 *      appears in editable contexts (i.e. the authoring editor) — the
 *      read-only `RichTextView` renders the same extension but skips the
 *      handle, so stored widths are honoured without any resize UI.
 *
 * We avoid a React NodeView on purpose: the image subtree has no nested
 * ProseMirror content, so a plain DOM view is smaller, faster, and has
 * no re-render surprises when the outer doc updates.
 */
export const ResizableImage = TiptapImage.extend({
  addAttributes() {
    const parent = this.parent?.() ?? {};
    return {
      ...parent,
      width: {
        default: null as string | null,
        parseHTML: (el) => {
          const html = el as HTMLElement;
          const styleW = html.style.width;
          if (styleW) return styleW;
          const attrW = html.getAttribute('width');
          return attrW || null;
        },
        renderHTML: (attrs: { width?: string | null }) => {
          if (!attrs.width) return {};
          return { style: `width: ${attrs.width}` };
        },
      },
    };
  },

  addNodeView() {
    return ({ node, editor, getPos }) => {
      const wrap = document.createElement('span');
      wrap.className = 'sd-img-wrap';

      const img = document.createElement('img');
      img.src = node.attrs.src ?? '';
      if (node.attrs.alt) img.alt = node.attrs.alt;
      if (node.attrs.title) img.title = node.attrs.title;
      wrap.appendChild(img);

      const applyWidth = (w: string | null) => {
        if (w) {
          wrap.style.width = w;
          img.style.width = '100%';
        } else {
          wrap.style.width = '';
          img.style.width = '';
        }
      };
      applyWidth(node.attrs.width ?? null);

      if (!editor.isEditable) {
        return { dom: wrap };
      }

      const handle = document.createElement('span');
      handle.className = 'sd-img-handle';
      handle.setAttribute('contenteditable', 'false');
      handle.setAttribute('aria-label', 'Resize image');
      handle.setAttribute('role', 'slider');
      wrap.appendChild(handle);

      let startX = 0;
      let startW = 0;
      let dragging = false;

      const onMove = (e: MouseEvent) => {
        if (!dragging) return;
        const dx = e.clientX - startX;
        const next = Math.max(80, Math.round(startW + dx));
        applyWidth(`${next}px`);
      };

      const commit = () => {
        dragging = false;
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        const pos = typeof getPos === 'function' ? getPos() : null;
        if (pos == null) return;
        const newWidth = wrap.style.width || null;
        const { view } = editor;
        const tr = view.state.tr.setNodeMarkup(pos, undefined, {
          ...node.attrs,
          width: newWidth,
        });
        view.dispatch(tr);
      };

      const onUp = () => {
        commit();
      };

      handle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        dragging = true;
        startX = e.clientX;
        startW = wrap.getBoundingClientRect().width;
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });

      return {
        dom: wrap,
        update(updatedNode) {
          if (updatedNode.type.name !== node.type.name) return false;
          const nextSrc = updatedNode.attrs.src ?? '';
          if (img.src !== nextSrc) img.src = nextSrc;
          const nextAlt = updatedNode.attrs.alt ?? '';
          if (img.alt !== nextAlt) img.alt = nextAlt;
          applyWidth(updatedNode.attrs.width ?? null);
          return true;
        },
        destroy() {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
        },
      };
    };
  },
});
