/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import { SidebarToolbar } from './sidebar-toolbar';

const openPalette = jest.fn();
jest.mock('next/navigation', () => ({ usePathname: () => '/admin' }));
jest.mock('../search/search-palette-provider', () => ({
  useSearchPalette: () => ({ open: openPalette, close: jest.fn(), isOpen: false }),
}));
jest.mock('../chat-panel/chat-panel-toggle', () => ({
  ChatPanelToggle: () => (
    <button type="button" aria-label="Ask anything" />
  ),
}));

beforeEach(() => jest.clearAllMocks());

describe('SidebarToolbar', () => {
  it('puts search between Starred and Ask anything', () => {
    render(<SidebarToolbar companyId="c1" variant="topbar" />);

    // Order is the contract here: the cluster is muscle memory, and
    // search was moved into it from the breadcrumb row.
    expect(
      screen.getAllByRole('button').concat(screen.getAllByRole('link'))
        .sort((a, b) =>
          a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
        )
        .map((el) => el.getAttribute('aria-label')),
    ).toEqual([
      'Expiring soon',
      'Open starred items',
      'Search everything',
      'Ask anything',
    ]);
  });

  it('opens the command palette rather than pretending to be an input', () => {
    render(<SidebarToolbar companyId="c1" variant="topbar" />);
    fireEvent.click(screen.getByRole('button', { name: 'Search everything' }));
    expect(openPalette).toHaveBeenCalledTimes(1);
  });

  it('drops search where a shell does not offer it', () => {
    render(<SidebarToolbar companyId="c1" variant="topbar" showSearch={false} />);
    expect(
      screen.queryByRole('button', { name: 'Search everything' }),
    ).not.toBeInTheDocument();
  });
});
