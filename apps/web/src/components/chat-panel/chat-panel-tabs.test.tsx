/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import {
  ChatPanelProvider,
  useChatPanel,
  type ChatTabContextMention,
} from './chat-panel-provider';

/**
 * "New chat" is idempotent. Before this rule every click appended a
 * tab, so an operator who clicked twice — or clicked once, wandered
 * off, and came back — accumulated a strip of identical empty "New
 * chat" tabs that each had to be closed by hand.
 *
 * The rule has one exception, pinned below: a tab carrying @-mention
 * context is not pristine. Reusing it would drop the operator into a
 * conversation pre-loaded with context they didn't ask for.
 */

jest.mock('../../lib/chat-api', () => ({
  applyChatToolCall: jest.fn(),
  createChatConversation: jest.fn(),
  deleteChatConversation: jest.fn(),
  getChatConversation: jest.fn(),
  rejectChatToolCall: jest.fn(),
}));
jest.mock('../../lib/api', () => ({ apiFetch: jest.fn() }));
jest.mock('../../lib/chat-stream', () => ({ streamChatMessage: jest.fn() }));
// Markdown projections for asset / domain page context. Only reached
// when a turn is actually sent; stubbed so this suite doesn't pull the
// ESM-only `marked` / `turndown` cone in for a reducer test.
jest.mock('../../lib/asset-format', () => ({ assetToMarkdown: jest.fn() }));
jest.mock('../../lib/domain-format', () => ({ domainToMarkdown: jest.fn() }));

const MENTION: ChatTabContextMention = {
  kind: 'article',
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  title: 'Backup runbook',
};

function Probe() {
  const { state, addFreeformTab, addMention, setActiveTab } = useChatPanel();
  const first = state.tabs[0];
  return (
    <div>
      <span data-testid="count">{state.tabs.length}</span>
      {/* Index rather than id — ids are random per run. */}
      <span data-testid="active">
        {state.tabs.findIndex((t) => t.id === state.activeTabId)}
      </span>
      <button type="button" onClick={addFreeformTab}>
        New chat
      </button>
      <button
        type="button"
        onClick={() => first && addMention(first.id, MENTION)}
      >
        Mention into first
      </button>
      <button type="button" onClick={() => first && setActiveTab(first.id)}>
        Activate first
      </button>
    </div>
  );
}

function renderProbe() {
  render(
    <ChatPanelProvider>
      <Probe />
    </ChatPanelProvider>,
  );
  return {
    newChat: () => fireEvent.click(screen.getByText('New chat')),
    mentionIntoFirst: () =>
      fireEvent.click(screen.getByText('Mention into first')),
    activateFirst: () => fireEvent.click(screen.getByText('Activate first')),
    count: () => screen.getByTestId('count').textContent,
    activeIndex: () => screen.getByTestId('active').textContent,
  };
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('New chat', () => {
  it('creates the first tab, then reuses it on every later click', () => {
    const ui = renderProbe();

    ui.newChat();
    expect(ui.count()).toBe('1');

    ui.newChat();
    ui.newChat();
    expect(ui.count()).toBe('1');
    expect(ui.activeIndex()).toBe('0');
  });

  it('focuses the pristine tab instead of the one in view', () => {
    const ui = renderProbe();

    // Tab 0 gets mention context, so it stops being reusable; tab 1
    // is then the pristine one.
    ui.newChat();
    ui.mentionIntoFirst();
    ui.newChat();
    expect(ui.count()).toBe('2');
    expect(ui.activeIndex()).toBe('1');

    // Switch back to tab 0 and click New chat: no third tab, and the
    // strip jumps to the pristine tab 1.
    ui.activateFirst();
    expect(ui.activeIndex()).toBe('0');
    ui.newChat();
    expect(ui.count()).toBe('2');
    expect(ui.activeIndex()).toBe('1');
  });

  it('creates a new tab when every open tab holds context', () => {
    const ui = renderProbe();

    ui.newChat();
    ui.mentionIntoFirst();
    expect(ui.count()).toBe('1');

    ui.newChat();
    expect(ui.count()).toBe('2');
    expect(ui.activeIndex()).toBe('1');
  });
});
