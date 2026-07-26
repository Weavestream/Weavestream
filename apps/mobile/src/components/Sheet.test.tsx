/**
 * @jest-environment jsdom
 */
/**
 * Sheet dismissal.
 *
 * The regression that prompted these: the drag-to-dismiss handler sits on
 * the header strip, and the close button sits **inside** it. Calling
 * `setPointerCapture` on the strip for every press retargets all
 * subsequent pointer events — including the click derived from them — to
 * the capturing element, so the close button's `onClick` never ran. The
 * sheet could only be dismissed with Escape or the scrim, and the most
 * obvious control on screen did nothing.
 *
 * jsdom implements neither pointer capture nor its retargeting, so the
 * symptom itself is not reproducible here. What *is* testable is the
 * invariant that fixes it: capture must never be taken when the press
 * landed on a control.
 */
import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import { Sheet } from './Sheet';

/** jsdom has no pointer capture; spy on it to assert intent. */
function stubPointerCapture() {
  const setPointerCapture = jest.fn();
  (Element.prototype as unknown as Record<string, unknown>).setPointerCapture =
    setPointerCapture;
  (
    Element.prototype as unknown as Record<string, unknown>
  ).releasePointerCapture = jest.fn();
  return setPointerCapture;
}

function renderSheet(onClose = jest.fn()) {
  render(
    <Sheet open onClose={onClose} title="Organizations">
      <div>body</div>
    </Sheet>,
  );
  return onClose;
}

describe('Sheet dismissal', () => {
  it('closes when the close button is tapped', () => {
    stubPointerCapture();
    const onClose = renderSheet();

    const close = screen.getByRole('button', { name: 'Close Organizations' });
    // A real tap is pointerdown → pointerup → click, and the pointerdown
    // reaches the drag strip by bubbling. All three, in order.
    fireEvent.pointerDown(close, { pointerId: 1, clientY: 100 });
    fireEvent.pointerUp(close, { pointerId: 1, clientY: 100 });
    fireEvent.click(close);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does NOT take pointer capture when the press lands on the close button', () => {
    // This is the fix. Capture on an ancestor swallows the descendant's
    // click, which is what broke the button.
    const setPointerCapture = stubPointerCapture();
    renderSheet();

    fireEvent.pointerDown(
      screen.getByRole('button', { name: 'Close Organizations' }),
      { pointerId: 1, clientY: 100 },
    );

    expect(setPointerCapture).not.toHaveBeenCalled();
  });

  it('still takes capture when the press lands on the strip itself', () => {
    // The drag gesture must keep working — the fix is targeted, not a
    // removal of drag-to-dismiss.
    const setPointerCapture = stubPointerCapture();
    renderSheet();

    fireEvent.pointerDown(screen.getByRole('dialog').firstElementChild!, {
      pointerId: 1,
      clientY: 100,
    });

    expect(setPointerCapture).toHaveBeenCalledTimes(1);
  });

  it('does not drag when the gesture started on a control', () => {
    // Belt and braces on the same fix: a press that began on the button
    // must not move the sheet even if the finger slides.
    stubPointerCapture();
    const onClose = renderSheet();
    const close = screen.getByRole('button', { name: 'Close Organizations' });
    const strip = screen.getByRole('dialog').firstElementChild!;

    fireEvent.pointerDown(close, { pointerId: 1, clientY: 100 });
    fireEvent.pointerMove(strip, { pointerId: 1, clientY: 400 });
    fireEvent.pointerUp(strip, { pointerId: 1, clientY: 400 });

    // No drag-dismiss fired; only an actual click would close it.
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).not.toHaveStyle({
      transform: 'translateY(300px)',
    });
  });

  it('dismisses on a drag past the threshold', () => {
    stubPointerCapture();
    const onClose = renderSheet();
    const strip = screen.getByRole('dialog').firstElementChild!;

    fireEvent.pointerDown(strip, { pointerId: 1, clientY: 100 });
    fireEvent.pointerMove(strip, { pointerId: 1, clientY: 300 });
    fireEvent.pointerUp(strip, { pointerId: 1, clientY: 300 });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('snaps back on a drag short of the threshold', () => {
    stubPointerCapture();
    const onClose = renderSheet();
    const strip = screen.getByRole('dialog').firstElementChild!;

    fireEvent.pointerDown(strip, { pointerId: 1, clientY: 100 });
    fireEvent.pointerMove(strip, { pointerId: 1, clientY: 130 });
    fireEvent.pointerUp(strip, { pointerId: 1, clientY: 130 });

    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes on Escape', () => {
    stubPointerCapture();
    const onClose = renderSheet();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on a scrim press that both starts and ends on the scrim', () => {
    stubPointerCapture();
    const onClose = renderSheet();
    const scrim = screen.getByRole('dialog').parentElement!;

    fireEvent.pointerDown(scrim, { pointerId: 1 });
    fireEvent.pointerUp(scrim, { pointerId: 1 });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not close when a press starts inside the panel and ends on the scrim', () => {
    // A drag released outside the panel is not a dismissal — the same
    // guard desktop's Sheet learned the hard way.
    stubPointerCapture();
    const onClose = renderSheet();
    const scrim = screen.getByRole('dialog').parentElement!;

    fireEvent.pointerDown(screen.getByText('body'), { pointerId: 1 });
    fireEvent.pointerUp(scrim, { pointerId: 1 });

    expect(onClose).not.toHaveBeenCalled();
  });
});
