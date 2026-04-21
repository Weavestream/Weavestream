'use client';

import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Editor } from '@tiptap/react';

/**
 * Minimal slash-menu: appears when the user types `/` at the start of an
 * empty block. Filters by substring against the preset commands below.
 * A richer Tiptap suggestion plugin can replace this in Phase 7, but the
 * current approach avoids pulling in ProseMirror suggestion internals.
 */

type Command = {
  key: string;
  label: string;
  icon: string;
  hint: string;
  run: (editor: Editor) => void;
  /**
   * Optional predicate; when false the command is hidden. Used to hide
   * variant-specific entries (e.g. tables are only registered on the
   * article editor, not the asset field editor).
   */
  available?: (editor: Editor) => boolean;
};

const COMMANDS: Command[] = [
  {
    key: 'h1',
    label: 'Heading 1',
    icon: 'H1',
    hint: '#',
    run: (e) => e.chain().focus().setHeading({ level: 1 }).run(),
  },
  {
    key: 'h2',
    label: 'Heading 2',
    icon: 'H2',
    hint: '##',
    run: (e) => e.chain().focus().setHeading({ level: 2 }).run(),
  },
  {
    key: 'h3',
    label: 'Heading 3',
    icon: 'H3',
    hint: '###',
    run: (e) => e.chain().focus().setHeading({ level: 3 }).run(),
  },
  {
    key: 'ul',
    label: 'Bulleted list',
    icon: '•',
    hint: '-',
    run: (e) => e.chain().focus().toggleBulletList().run(),
  },
  {
    key: 'ol',
    label: 'Numbered list',
    icon: '1',
    hint: '1.',
    run: (e) => e.chain().focus().toggleOrderedList().run(),
  },
  {
    key: 'task',
    label: 'Task list',
    icon: '☑',
    hint: '[]',
    run: (e) => e.chain().focus().toggleTaskList().run(),
  },
  {
    key: 'code',
    label: 'Code block',
    icon: '<>',
    hint: '```',
    run: (e) => e.chain().focus().toggleCodeBlock().run(),
  },
  {
    key: 'quote',
    label: 'Quote',
    icon: '“”',
    hint: '>',
    run: (e) => e.chain().focus().toggleBlockquote().run(),
  },
  {
    key: 'hr',
    label: 'Divider',
    icon: '─',
    hint: '---',
    run: (e) => e.chain().focus().setHorizontalRule().run(),
  },
  {
    key: 'table',
    label: 'Table',
    icon: '⊞',
    hint: '3×3',
    run: (e) =>
      e
        .chain()
        .focus()
        .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
        .run(),
    available: (e) =>
      e.extensionManager.extensions.some((ext) => ext.name === 'table'),
  },
];

export function SlashMenu({ editor }: { editor: Editor }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [selected, setSelected] = useState(0);

  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    const visible = COMMANDS.filter(
      (c) => !c.available || c.available(editor),
    );
    if (!q) return visible;
    return visible.filter(
      (c) => c.label.toLowerCase().includes(q) || c.key.includes(q),
    );
  }, [query, editor]);

  useEffect(() => {
    if (!editor) return;
    const update = () => {
      const { state, view } = editor;
      const { from, empty } = state.selection;
      if (!empty) {
        setOpen(false);
        return;
      }
      const $from = state.selection.$from;
      const parent = $from.parent;
      // Only trigger in paragraph-start contexts with a leading '/'.
      const paraText = parent.textContent ?? '';
      if (!paraText.startsWith('/')) {
        setOpen(false);
        return;
      }
      if (paraText.length > 40) {
        setOpen(false);
        return;
      }
      if (parent.type.name !== 'paragraph') {
        setOpen(false);
        return;
      }
      const raw = paraText.slice(1);
      setQuery(raw);
      setSelected(0);
      try {
        const rect = view.coordsAtPos(from);
        setPos({ left: rect.left, top: rect.bottom + 4 });
        setOpen(true);
      } catch {
        setOpen(false);
      }
    };
    editor.on('selectionUpdate', update);
    editor.on('update', update);
    update();
    return () => {
      editor.off('selectionUpdate', update);
      editor.off('update', update);
    };
  }, [editor]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (!open) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelected((s) => (s + 1) % filtered.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelected((s) => (s - 1 + filtered.length) % filtered.length);
      } else if (e.key === 'Enter') {
        const cmd = filtered[selected];
        if (cmd) {
          e.preventDefault();
          applyCommand(editor, cmd);
          setOpen(false);
        }
      } else if (e.key === 'Escape') {
        setOpen(false);
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [open, filtered, selected, editor]);

  if (!open || !pos || typeof document === 'undefined') return null;

  // Portal into <body> so the menu escapes any ancestor `overflow: hidden`
  // or containing-block-forming transform on the editor's wrapper (the
  // asset form wraps the editor in an `overflow: hidden` panel, which was
  // clipping the fixed-positioned popover and making it invisible).
  // Matches how the mention popover uses tippy with `appendTo: body`.
  return createPortal(
    <div
      className="sd-popover"
      style={{
        position: 'fixed',
        left: pos.left,
        top: pos.top,
        zIndex: 1000,
      }}
    >
      <div className="sd-popover-head">Insert</div>
      {filtered.length === 0 && (
        <div className="sd-popover-head" style={{ color: 'var(--muted)' }}>
          No matching blocks
        </div>
      )}
      {filtered.map((cmd, i) => (
        <button
          key={cmd.key}
          type="button"
          className="sd-popover-item"
          data-active={i === selected}
          onMouseEnter={() => setSelected(i)}
          onClick={() => {
            applyCommand(editor, cmd);
            setOpen(false);
          }}
        >
          <span className="sd-popover-item-icon">{cmd.icon}</span>
          <span className="sd-popover-item-label">{cmd.label}</span>
          <span className="sd-popover-item-hint">{cmd.hint}</span>
        </button>
      ))}
    </div>,
    document.body,
  );
}

function applyCommand(editor: Editor, cmd: { run: (e: Editor) => void }) {
  // Strip the trailing "/query" text before applying the command so the
  // user's slash query doesn't survive into the new block.
  const { state } = editor;
  const $from = state.selection.$from;
  const paraStart = $from.start();
  editor
    .chain()
    .focus()
    .deleteRange({ from: paraStart, to: state.selection.from })
    .run();
  cmd.run(editor);
}
