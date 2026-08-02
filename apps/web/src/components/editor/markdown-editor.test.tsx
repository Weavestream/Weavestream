/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { markdownLanguage } from '@codemirror/lang-markdown';
import { highlightTree, tags as t } from '@lezer/highlight';
import { render } from '@testing-library/react';
import { MarkdownEditor, markdownHighlightStyle } from './markdown-editor';

jest.mock('./editor.css', () => ({}));

jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

jest.mock('remark-gfm', () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock('@uiw/react-codemirror', () => ({
  __esModule: true,
  default: () => <div data-testid="codemirror" />,
}));

jest.mock('react-resizable-panels', () => ({
  Group: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Panel: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
  Separator: () => <div data-separator="true" />,
  useDefaultLayout: () => ({
    defaultLayout: undefined,
    onLayoutChanged: jest.fn(),
  }),
}));

jest.mock('./image-picker-dialog', () => ({
  ImagePickerDialog: () => null,
}));

describe('MarkdownEditor split view', () => {
  it('labels only the preview pane', () => {
    const { container } = render(
      <MarkdownEditor
        value="# Heading"
        onChange={jest.fn()}
        view="split"
        onViewChange={jest.fn()}
        companyId="company-1"
      />,
    );

    const pills = container.querySelectorAll('.sd-md-preview-pill');
    expect(pills).toHaveLength(1);
    const pill = pills.item(0);
    expect(pill).toHaveTextContent('Preview');
    expect(pill).not.toHaveTextContent('Edit');
    expect(pill.parentElement).toHaveClass('sd-md-split-workspace');
  });
});

type HighlightedSegment = {
  text: string;
  base: boolean;
  strong: boolean;
};

function highlightedSegments(source: string): HighlightedSegment[] {
  const baseClass = markdownHighlightStyle.style([]);
  const strongClass = markdownHighlightStyle
    .style([t.strong])
    ?.split(' ')
    .find((className) => className !== baseClass);
  if (!baseClass || !strongClass) throw new Error('Markdown emphasis styles are incomplete');

  const segments: HighlightedSegment[] = [];
  highlightTree(
    markdownLanguage.parser.parse(source),
    markdownHighlightStyle,
    (from, to, classes) => {
      const classNames = classes.split(' ');
      segments.push({
        text: source.slice(from, to),
        base: classNames.includes(baseClass),
        strong: classNames.includes(strongClass),
      });
    },
  );
  return segments;
}

describe('MarkdownEditor emphasis highlighting', () => {
  it.each([
    ['complete span', '**bold** after', '**bold**', ' after'],
    [
      'multiple spans and adjacent punctuation',
      '**one** and **two**, done',
      '**one****two**',
      ' and , done',
    ],
    ['incomplete span', '**unfinished', '', '**unfinished'],
    ['multiline span', '**first\nsecond** tail', '**first\nsecond**', ' tail'],
  ])(
    'keeps strong styling inside markers for a %s',
    (_label, source, expectedStrong, expectedPlain) => {
      const segments = highlightedSegments(source);
      expect(segments.every((segment) => segment.base)).toBe(true);
      expect(
        segments
          .filter((segment) => segment.strong)
          .map((segment) => segment.text)
          .join(''),
      ).toBe(expectedStrong);
      expect(
        segments
          .filter((segment) => !segment.strong)
          .map((segment) => segment.text)
          .join(''),
      ).toBe(expectedPlain);
    },
  );

  it('does not apply the accent color to an entire list item', () => {
    // Lezer applies `t.list` to the whole list-item subtree, not just its
    // marker. Styling that tag therefore paints all text after `**` with
    // the accent color even though the emphasis range closed correctly.
    const baseClass = markdownHighlightStyle.style([]);
    expect(markdownHighlightStyle.style([t.list])).toBe(baseClass);

    const source = '- **Active Directory Services**: The server hosts the Root Domain.';
    const segments = highlightedSegments(source);
    expect(
      segments
        .filter((segment) => segment.strong)
        .map((segment) => segment.text)
        .join(''),
    ).toBe('**Active Directory Services**');
    expect(
      segments
        .filter((segment) => !segment.strong)
        .map((segment) => segment.text)
        .join(''),
    ).toBe('- : The server hosts the Root Domain.');
  });
});
