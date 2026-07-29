/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ChatToolCallDto } from '@weavestream/shared';
import { fireEvent, render as rtlRender, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { Org } from '../../lib/org-scope';
import { initialAskState, type AskState } from './ask-reducer';

const ORG: Org = { id: 'org-1', name: 'Acme', initials: 'AC', subtitle: null };

const askValue = {
  state: initialAskState as AskState,
  setDraft: jest.fn(),
  send: jest.fn(),
  stop: jest.fn(),
  newChat: jest.fn(),
  applyToolCall: jest.fn(),
  rejectToolCall: jest.fn(),
};

jest.mock('./AskProvider', () => ({ useAsk: () => askValue }));
jest.mock('../../lib/org-scope', () => ({
  useOrgScope: () => ({ currentOrg: ORG, scopeStatus: 'ready' }),
}));
jest.mock('../../lib/api', () => ({ apiFetch: jest.fn(() => new Promise(() => {})) }));

import { AskScreen } from './AskScreen';

/** ProposalCard pulls TanStack Query (base fetch + org chip). */
function render(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return rtlRender(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function state(partial: Partial<AskState>): AskState {
  return { ...initialAskState, ...partial };
}

function message(
  partial: Partial<AskState['messages'][number]> &
    Pick<AskState['messages'][number], 'clientId' | 'role'>,
): AskState['messages'][number] {
  return {
    text: '',
    state: 'done',
    notices: [],
    toolCalls: [],
    serverMessageId: null,
    scopeCompanyId: null,
    ...partial,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  askValue.state = initialAskState;
});

describe('AskScreen', () => {
  it('renders nothing while closed', () => {
    const { container } = render(<AskScreen open={false} onClose={jest.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the transcript from provider state with the org pill', () => {
    askValue.state = state({
      conversationId: 'c1',
      messages: [
        message({ clientId: 'u1', role: 'user', text: 'reboot steps?' }),
        message({
          clientId: 'a1',
          role: 'assistant',
          text: 'Power off, then on.',
        }),
      ],
    });
    render(<AskScreen open onClose={jest.fn()} />);

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Ask anything')).toBeInTheDocument();
    expect(screen.getByText('Acme')).toBeInTheDocument();
    expect(screen.getByText('reboot steps?')).toBeInTheDocument();
    expect(screen.getByText(/Power off, then on\./)).toBeInTheDocument();
    expect(screen.getByText(/never a password or asset/)).toBeInTheDocument();
  });

  it('never autofocuses the composer — focus lands on Close', () => {
    render(<AskScreen open onClose={jest.fn()} />);
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
    expect(
      screen.getByRole('textbox', { name: 'Ask about this organization' }),
    ).not.toHaveFocus();
  });

  it('shows Stop and disables the composer during creating, preflight, AND streaming', () => {
    for (const status of ['creating', 'preflight', 'streaming'] as const) {
      askValue.state = state({
        status,
        messages: [
          message({ clientId: 'u1', role: 'user', text: 'q' }),
          message({
            clientId: 'a1',
            role: 'assistant',
            state: 'streaming',
          }),
        ],
      });
      const { unmount } = render(<AskScreen open onClose={jest.fn()} />);

      expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: 'Send' }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole('textbox', { name: 'Ask about this organization' }),
      ).toBeDisabled();

      fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
      expect(askValue.stop).toHaveBeenCalled();
      unmount();
      jest.clearAllMocks();
    }
  });

  it('renders a post-meta stream failure in-bubble, with the composer unlocked', () => {
    askValue.state = state({
      status: 'idle',
      messages: [
        message({ clientId: 'u1', role: 'user', text: 'q' }),
        message({
          clientId: 'a1',
          role: 'assistant',
          text: 'partial answer',
          state: 'error',
          error: 'Model failed',
        }),
      ],
    });
    render(<AskScreen open onClose={jest.fn()} />);

    expect(screen.getByText('Model failed')).toBeInTheDocument();
    expect(screen.getByText(/partial answer/)).toBeInTheDocument();
    expect(
      screen.getByRole('textbox', { name: 'Ask about this organization' }),
    ).toBeEnabled();
  });

  it('surfaces a rolled-back send via the sendError line with the draft restored', () => {
    askValue.state = state({
      sendError: 'AI integration is disabled',
      draft: 'reboot steps?',
    });
    render(<AskScreen open onClose={jest.fn()} />);

    expect(screen.getByRole('alert')).toHaveTextContent(
      'AI integration is disabled',
    );
    expect(
      screen.getByRole('textbox', { name: 'Ask about this organization' }),
    ).toHaveValue('reboot steps?');
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
  });

  it('renders actionable proposal cards; read tools never become cards (5b)', () => {
    askValue.state = state({
      messages: [
        message({ clientId: 'u1', role: 'user', text: 'draft it' }),
        message({
          clientId: 'a1',
          role: 'assistant',
          text: 'Drafted.',
          toolCalls: [
            {
              id: 't1',
              name: 'create_article',
              arguments: { title: 'Reboot runbook' },
              status: 'pending',
            },
            // The tool_call event also carries executed READ tools —
            // they must not become cards.
            {
              id: 't2',
              name: 'search',
              arguments: { q: 'x' },
              status: 'executed',
            },
          ] as unknown as ChatToolCallDto[],
        }),
      ],
    });
    render(<AskScreen open onClose={jest.fn()} />);

    expect(screen.getByText('Drafted an article')).toBeInTheDocument();
    expect(screen.getByText('Reboot runbook')).toBeInTheDocument();
    // The Phase 3 desktop-handoff line is gone; the card is actionable.
    expect(screen.queryByText('Review and apply on desktop.')).toBeNull();
    expect(screen.getAllByText(/Drafted an/)).toHaveLength(1);
    expect(screen.getByRole('button', { name: /apply/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reject/i })).toBeInTheDocument();
  });

  it('shows New chat only once a transcript exists, wired to the provider', () => {
    render(<AskScreen open onClose={jest.fn()} />);
    expect(screen.queryByRole('button', { name: 'New chat' })).toBeNull();

    askValue.state = state({
      messages: [message({ clientId: 'u1', role: 'user', text: 'q' })],
    });
    render(<AskScreen open onClose={jest.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    expect(askValue.newChat).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape and on the close button', () => {
    const onClose = jest.fn();
    render(<AskScreen open onClose={onClose} />);

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
