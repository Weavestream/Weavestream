'use client';

import { useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import './editor.css';

export type MarkdownEditorProps = {
  value: string;
  onChange: (next: string) => void;
  autoFocus?: boolean;
  /**
   * Mirror of `RichTextEditor.toolbarPortalTarget`: when set, the
   * Edit / Split / Preview controls are rendered into the given element
   * via `createPortal` so they sit in the same toolbar slot the Tiptap
   * editor uses. Without it the toolbar renders inline above the body.
   */
  toolbarPortalTarget?: HTMLElement | null;
};

type ViewMode = 'edit' | 'split' | 'preview';

/**
 * Authoring surface for Markdown articles: textarea plus optional
 * live preview. Defaults to plain editing — users can opt into split
 * or preview-only via the toolbar.
 */
export function MarkdownEditor({
  value,
  onChange,
  autoFocus = false,
  toolbarPortalTarget,
}: MarkdownEditorProps) {
  const [view, setView] = useState<ViewMode>('edit');

  const showEditor = view === 'edit' || view === 'split';
  const showPreview = view === 'preview' || view === 'split';

  const onTextChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      onChange(e.target.value);
    },
    [onChange],
  );

  const toolbar = (
    <div className="sd-editor-toolbar">
      <div className="sd-editor-toolbar-group">
        <ToolbarButton active={view === 'edit'} onClick={() => setView('edit')}>
          Edit
        </ToolbarButton>
        <ToolbarButton
          active={view === 'split'}
          onClick={() => setView('split')}
        >
          Split
        </ToolbarButton>
        <ToolbarButton
          active={view === 'preview'}
          onClick={() => setView('preview')}
        >
          Preview
        </ToolbarButton>
      </div>
      <div style={{ flex: 1 }} />
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 10.5,
          color: 'var(--dim)',
          textTransform: 'uppercase',
          letterSpacing: 0.4,
          paddingRight: 8,
        }}
      >
        markdown
      </span>
    </div>
  );

  return (
    <>
      {toolbarPortalTarget ? createPortal(toolbar, toolbarPortalTarget) : toolbar}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns:
            showEditor && showPreview ? '1fr 1fr' : 'minmax(0, 1fr)',
          gap: showEditor && showPreview ? 20 : 0,
          minHeight: 420,
          alignItems: 'stretch',
        }}
      >
        {showEditor && (
          <textarea
            value={value}
            onChange={onTextChange}
            autoFocus={autoFocus}
            spellCheck
            className="sd-md-textarea"
            style={{
              width: '100%',
              minHeight: 420,
              resize: 'vertical',
              boxSizing: 'border-box',
              fontFamily: 'var(--font-mono)',
              fontSize: 13,
              lineHeight: 1.55,
              padding: 16,
              borderRadius: 8,
              border: '1px solid var(--line-2)',
              background: 'var(--panel-2)',
              color: 'var(--text)',
              outline: 'none',
            }}
            placeholder="Write Markdown…"
            aria-label="Markdown source"
          />
        )}
        {showPreview && (
          <div
            className="sd-editor sd-editor-article sd-richtext-view sd-markdown-view"
            style={{
              minHeight: 420,
              overflow: 'auto',
              padding: 16,
              borderRadius: 8,
              border: '1px solid var(--line-2)',
              background: 'var(--panel)',
            }}
          >
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{value || ' '}</ReactMarkdown>
          </div>
        )}
      </div>
    </>
  );
}

function ToolbarButton({
  active,
  onClick,
  children,
}: {
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className="sd-editor-btn"
      data-active={active ? 'true' : 'false'}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
