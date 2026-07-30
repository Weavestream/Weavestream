'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import CodeMirror, { type Extension } from '@uiw/react-codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { EditorView, keymap } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels';
import { Icon } from '../ui';
import { ImagePickerDialog } from './image-picker-dialog';
import { MarkdownView } from './markdown-view';
import './editor.css';

export type MarkdownEditorProps = {
  value: string;
  onChange: (next: string) => void;
  view: MarkdownViewMode;
  onViewChange: (next: MarkdownViewMode) => void;
  autoFocus?: boolean;
  /**
   * Required when image insertion is enabled — the picker uploads via
   * the company-scoped `/companies/:id/uploads/*` endpoints. Pass the
   * same value you give the surrounding `RichTextEditor` so switching
   * editor modes keeps the same upload tenant.
   */
  companyId: string;
  /**
   * Mirror of `RichTextEditor.toolbarPortalTarget`: when set, the
   * Edit / Split / Preview controls are rendered into the given element
   * via `createPortal` so they sit in the same toolbar slot the Tiptap
   * editor uses. Without it the toolbar renders inline above the body.
   */
  toolbarPortalTarget?: HTMLElement | null;
  /** Optional control rendered at the far right of the Markdown toolbar. */
  toolbarEnd?: React.ReactNode;
};

export type MarkdownViewMode = 'edit' | 'split' | 'preview';

/* Markdown syntax theme. Colors come from the design-token CSS variables so
 * the editor stays consistent with the rest of the app — and tracks the
 * dark/light theme switch automatically without a second config. */
const markdownHighlightStyle = HighlightStyle.define([
  { tag: t.heading1, color: 'var(--text)', fontWeight: '700' },
  { tag: t.heading2, color: 'var(--text)', fontWeight: '700' },
  { tag: t.heading3, color: 'var(--text)', fontWeight: '600' },
  { tag: [t.heading4, t.heading5, t.heading6], color: 'var(--text)', fontWeight: '600' },
  { tag: t.strong, color: 'var(--text)', fontWeight: '700' },
  { tag: t.emphasis, color: 'var(--text-2)', fontStyle: 'italic' },
  { tag: t.strikethrough, color: 'var(--dim)', textDecoration: 'line-through' },
  { tag: t.link, color: 'var(--accent)' },
  { tag: t.url, color: 'var(--accent)', textDecoration: 'underline' },
  { tag: t.monospace, color: 'var(--accent)', fontFamily: 'var(--font-mono)' },
  { tag: [t.processingInstruction, t.string, t.inserted], color: 'var(--accent)' },
  { tag: t.contentSeparator, color: 'var(--dim)' },
  { tag: t.list, color: 'var(--accent)' },
  { tag: t.quote, color: 'var(--text-2)', fontStyle: 'italic' },
  { tag: [t.meta, t.comment], color: 'var(--dim)' },
  { tag: t.atom, color: 'var(--accent)' },
  { tag: t.keyword, color: 'var(--accent)', fontWeight: '600' },
  { tag: t.tagName, color: 'var(--accent)' },
  { tag: t.attributeName, color: 'var(--text-2)' },
  { tag: t.number, color: 'var(--accent)' },
]);

export function MarkdownEditor({
  value,
  onChange,
  view,
  onViewChange,
  autoFocus = false,
  companyId,
  toolbarPortalTarget,
  toolbarEnd,
}: MarkdownEditorProps) {
  const previewScrollRef = useRef<HTMLDivElement | null>(null);
  const [editorScrollEl, setEditorScrollEl] = useState<HTMLElement | null>(null);
  const editorViewRef = useRef<EditorView | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const insertAtCursor = useCallback((insert: string) => {
    const v = editorViewRef.current;
    if (!v) return;
    const { from, to } = v.state.selection.main;
    const needsLeadingNewline = from > 0 && v.state.doc.sliceString(from - 1, from) !== '\n';
    const needsTrailingNewline =
      to < v.state.doc.length && v.state.doc.sliceString(to, to + 1) !== '\n';
    const finalInsert =
      (needsLeadingNewline ? '\n' : '') + insert + (needsTrailingNewline ? '\n' : '');
    v.dispatch({
      changes: { from, to, insert: finalInsert },
      selection: { anchor: from + finalInsert.length },
      scrollIntoView: true,
    });
    v.focus();
  }, []);

  const showEditor = view === 'edit' || view === 'split';
  const showPreview = view === 'preview' || view === 'split';
  const previewMarkdown = useMemo(() => stripMarkdownFrontmatter(value), [value]);

  const cmExtensions = useMemo<Extension[]>(
    () => [
      markdown({ codeLanguages: languages }),
      EditorView.lineWrapping,
      keymap.of([indentWithTab]),
      syntaxHighlighting(markdownHighlightStyle),
      EditorView.theme(
        {
          '&': {
            display: 'flex',
            flexDirection: 'column',
            height: '100%',
            minHeight: '0',
            fontSize: '13px',
          },
          '.cm-scroller': {
            flex: '1 1 0',
            minHeight: '0',
            height: '100%',
            fontFamily: 'var(--font-mono)',
            lineHeight: '1.6',
          },
          '.cm-content': {
            caretColor: 'var(--text)',
          },
          '&.cm-focused': {
            outline: 'none',
          },
          '.cm-line': {
            padding: '0 8px',
          },
          '.cm-cursor, .cm-dropCursor': {
            borderLeftColor: 'var(--text)',
          },
          '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
            {
              background: 'var(--accent-soft)',
            },
          '.cm-activeLine': {
            backgroundColor: 'transparent',
          },
        },
        { dark: false },
      ),
    ],
    [],
  );

  const handleCmChange = useCallback(
    (next: string) => {
      onChange(next);
    },
    [onChange],
  );

  useEffect(() => {
    if (!editorScrollEl) return;

    const syncPreviewScroll = () => {
      const previewEl = previewScrollRef.current;
      if (!previewEl) return;

      const editorMaxScroll = editorScrollEl.scrollHeight - editorScrollEl.clientHeight;
      const previewMaxScroll = previewEl.scrollHeight - previewEl.clientHeight;

      if (editorMaxScroll <= 0 || previewMaxScroll <= 0) {
        previewEl.scrollTop = 0;
        return;
      }

      previewEl.scrollTop = (editorScrollEl.scrollTop / editorMaxScroll) * previewMaxScroll;
    };

    editorScrollEl.addEventListener('scroll', syncPreviewScroll, {
      passive: true,
    });
    syncPreviewScroll();

    return () => {
      editorScrollEl.removeEventListener('scroll', syncPreviewScroll);
    };
  }, [editorScrollEl]);

  const editorPane = (
    <div className="sd-md-cm-wrap" style={paneFillStyle}>
      <CodeMirror
        className="sd-md-codemirror"
        style={codeMirrorWrapStyle}
        value={value}
        onChange={handleCmChange}
        autoFocus={autoFocus}
        extensions={cmExtensions}
        basicSetup={{
          lineNumbers: true,
          foldGutter: false,
          highlightActiveLine: false,
          highlightActiveLineGutter: true,
          dropCursor: true,
          allowMultipleSelections: true,
          indentOnInput: true,
          bracketMatching: true,
          closeBrackets: true,
          autocompletion: false,
          rectangularSelection: true,
          crosshairCursor: false,
          searchKeymap: true,
          historyKeymap: true,
          defaultKeymap: true,
        }}
        placeholder="Write Markdown…"
        aria-label="Markdown source"
        height="100%"
        onCreateEditor={(nextView) => {
          editorViewRef.current = nextView;
          setEditorScrollEl(nextView.scrollDOM);
        }}
      />
    </div>
  );

  const previewPane = (
    <div ref={previewScrollRef} className="sd-md-preview-wrap" style={previewWrapStyle}>
      {/* The same component the read view renders, so the preview
          cannot drift from what a reader will see — this used to be a
          duplicate <ReactMarkdown> that had to be kept in step by hand.
          `showDiagramErrors` is the one deliberate difference: an author
          can act on a Mermaid parse message, a portal reader cannot. */}
      <MarkdownView
        source={previewMarkdown || ' '}
        bodyClassName="sd-md-preview"
        bodyStyle={previewSurfaceStyle}
        showDiagramErrors
      />
    </div>
  );

  const toolbar = (
    <div className="sd-editor-toolbar">
      <div className="sd-editor-toolbar-group">
        <ToolbarButton active={view === 'edit'} onClick={() => onViewChange('edit')}>
          Edit
        </ToolbarButton>
        <ToolbarButton active={view === 'split'} onClick={() => onViewChange('split')}>
          Split
        </ToolbarButton>
        <ToolbarButton active={view === 'preview'} onClick={() => onViewChange('preview')}>
          Preview
        </ToolbarButton>
      </div>
      <div className="sd-editor-toolbar-group">
        <ToolbarButton
          onClick={() => setPickerOpen(true)}
          title="Insert image"
          aria-label="Insert image"
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Icon.image size={12} />
            <span>Image</span>
          </span>
        </ToolbarButton>
      </div>
      <div style={{ flex: 1 }} />
      {toolbarEnd}
    </div>
  );

  return (
    <>
      {toolbarPortalTarget ? createPortal(toolbar, toolbarPortalTarget) : toolbar}

      <ImagePickerDialog
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        companyId={companyId}
        currentBody={value}
        onPick={(md) => {
          insertAtCursor(md);
          setPickerOpen(false);
        }}
      />

      <div className="sd-md-shell" data-view={view} style={shellStyle}>
        {showEditor && showPreview ? (
          <SplitPanes editor={editorPane} preview={previewPane} />
        ) : showEditor ? (
          <div className="sd-md-pane sd-md-pane-solo" style={soloPaneStyle}>
            {editorPane}
          </div>
        ) : (
          <div className="sd-md-pane sd-md-pane-solo" style={soloPaneStyle}>
            {previewPane}
          </div>
        )}
      </div>
    </>
  );
}

function SplitPanes({ editor, preview }: { editor: React.ReactNode; preview: React.ReactNode }) {
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: 'markdown-editor-split',
    panelIds: ['editor', 'preview'],
    storage: typeof window !== 'undefined' ? window.localStorage : undefined,
  });

  return (
    <div className="sd-md-split-workspace">
      <Group
        orientation="horizontal"
        className="sd-md-panels"
        defaultLayout={defaultLayout}
        onLayoutChanged={onLayoutChanged}
        style={panelGroupStyle}
      >
        <Panel
          id="editor"
          defaultSize="50%"
          minSize="20%"
          className="sd-md-pane"
          style={panelContentStyle}
        >
          {editor}
        </Panel>
        <Separator className="sd-md-resize-handle" style={separatorStyle} />
        <Panel
          id="preview"
          defaultSize="50%"
          minSize="20%"
          className="sd-md-pane"
          style={panelContentStyle}
        >
          {preview}
        </Panel>
      </Group>
      <div className="sd-md-preview-pill">
        <Icon.eye size={11} />
        <span>Preview</span>
      </div>
    </div>
  );
}

const panelContentStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  flex: '1 1 0',
  height: '100%',
  minHeight: 0,
  minWidth: 0,
  overflow: 'hidden',
};

const shellStyle: React.CSSProperties = {
  flex: '1 1 0',
  minHeight: 0,
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  border: '1px solid var(--line-2)',
  borderRadius: 8,
  background: 'var(--surface)',
};

const panelGroupStyle: React.CSSProperties = {
  flex: '1 1 0',
  height: '100%',
  minHeight: 0,
  width: '100%',
};

const soloPaneStyle: React.CSSProperties = {
  ...panelContentStyle,
  background: 'var(--surface)',
};

const paneFillStyle: React.CSSProperties = {
  flex: '1 1 0',
  minHeight: 0,
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
};

const codeMirrorWrapStyle: React.CSSProperties = {
  ...paneFillStyle,
  width: '100%',
};

const previewWrapStyle: React.CSSProperties = {
  ...paneFillStyle,
  overflow: 'auto',
  padding: '28px 34px',
  background: 'var(--panel-2)',
};

const previewSurfaceStyle: React.CSSProperties = {
  boxSizing: 'border-box',
  width: '100%',
  maxWidth: 820,
  minHeight: 0,
  margin: '0 auto',
  padding: 0,
  background: 'transparent',
  border: 0,
  boxShadow: 'none',
};

const separatorStyle: React.CSSProperties = {
  position: 'relative',
  alignSelf: 'stretch',
  width: 8,
  margin: 0,
  borderRadius: 0,
  border: 0,
  cursor: 'col-resize',
};

function stripMarkdownFrontmatter(source: string): string {
  const withoutBom = source.replace(/^\uFEFF/, '');
  const lines = withoutBom.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return source;

  const closingIndex = lines.findIndex((line, index) => {
    return index > 0 && line.trim() === '---';
  });

  if (closingIndex === -1) return source;
  return lines
    .slice(closingIndex + 1)
    .join('\n')
    .replace(/^\n+/, '');
}

function ToolbarButton({
  active,
  onClick,
  children,
  title,
  'aria-label': ariaLabel,
}: {
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
  title?: string;
  'aria-label'?: string;
}) {
  return (
    <button
      type="button"
      className="sd-editor-btn"
      data-active={active ? 'true' : 'false'}
      onClick={onClick}
      title={title}
      aria-label={ariaLabel}
    >
      {children}
    </button>
  );
}
