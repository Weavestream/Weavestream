/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { render } from '@testing-library/react';
import { MarkdownEditor } from './markdown-editor';

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
