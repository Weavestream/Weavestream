/**
 * @jest-environment jsdom
 */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { TagsInput } from './TagsInput';

jest.mock('../../lib/api', () => {
  const actual = jest.requireActual('../../lib/api');
  return { ...actual, apiFetch: jest.fn() };
});
const { apiFetch } = jest.requireMock('../../lib/api') as { apiFetch: jest.Mock };

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  apiFetch.mockResolvedValue({ items: [] });
});
afterEach(() => {
  jest.useRealTimers();
});

function renderTags(value: Array<{ id?: string; name: string }> = []) {
  const onChange = jest.fn();
  render(<TagsInput id="tags" value={value} onChange={onChange} />);
  return onChange;
}

describe('TagsInput commits', () => {
  it('Enter commits the draft as a {name} chip and clears the input', () => {
    const onChange = renderTags();
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: ' new-tag ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith([{ name: 'new-tag' }]);
  });

  it('comma commits like Enter', () => {
    const onChange = renderTags();
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'noc' } });
    fireEvent.keyDown(input, { key: ',' });
    expect(onChange).toHaveBeenCalledWith([{ name: 'noc' }]);
  });

  it('blur commits a non-empty draft', () => {
    const onChange = renderTags();
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'field-note' } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith([{ name: 'field-note' }]);
  });

  it('dedupes case-insensitively against existing chips', () => {
    const onChange = renderTags([{ id: 't1', name: 'NOC' }]);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'noc' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('Backspace on an empty draft removes the last chip', () => {
    const onChange = renderTags([{ id: 't1', name: 'noc' }, { name: 'draft' }]);
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Backspace' });
    expect(onChange).toHaveBeenCalledWith([{ id: 't1', name: 'noc' }]);
  });

  it('chip remove buttons drop the chip', () => {
    const onChange = renderTags([{ id: 't1', name: 'noc' }]);
    fireEvent.click(screen.getByRole('button', { name: 'Remove tag noc' }));
    expect(onChange).toHaveBeenCalledWith([]);
  });
});

describe('TagsInput autocomplete', () => {
  it('debounces the /tags lookup and keeps the id when a suggestion is picked', async () => {
    apiFetch.mockResolvedValue({
      items: [{ id: 't9', name: 'network' }],
    });
    const onChange = renderTags();
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'net' } });

    // Nothing fires before the debounce window.
    expect(apiFetch).not.toHaveBeenCalled();
    await act(async () => {
      jest.advanceTimersByTime(200);
    });
    expect(apiFetch).toHaveBeenCalledWith(
      '/tags?q=net&limit=8',
      expect.objectContaining({ signal: expect.anything() }),
    );

    const suggestion = await screen.findByRole('button', { name: 'network' });
    fireEvent.pointerDown(suggestion);
    expect(onChange).toHaveBeenCalledWith([{ id: 't9', name: 'network' }]);
  });

  it('clearing the draft aborts the in-flight lookup — a late response cannot repopulate stale suggestions', async () => {
    let resolveLookup: (v: unknown) => void = () => {};
    let capturedSignal: AbortSignal | undefined;
    apiFetch.mockImplementation((_path: string, init?: { signal?: AbortSignal }) => {
      capturedSignal = init?.signal;
      return new Promise((resolve) => (resolveLookup = resolve));
    });
    renderTags();
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'net' } });
    await act(async () => {
      jest.advanceTimersByTime(200);
    });
    expect(apiFetch).toHaveBeenCalled();

    // User deletes the draft while the request is still in flight.
    fireEvent.change(input, { target: { value: '' } });
    expect(capturedSignal?.aborted).toBe(true);

    // The stale response lands late — nothing may appear.
    await act(async () => {
      resolveLookup({ items: [{ id: 't9', name: 'network' }] });
    });
    expect(screen.queryByRole('button', { name: 'network' })).not.toBeInTheDocument();
  });

  it('an exact-match Enter uses the suggestion id instead of a new {name}', async () => {
    apiFetch.mockResolvedValue({ items: [{ id: 't9', name: 'network' }] });
    const onChange = renderTags();
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'network' } });
    await act(async () => {
      jest.advanceTimersByTime(200);
    });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith([{ id: 't9', name: 'network' }]);
  });
});
