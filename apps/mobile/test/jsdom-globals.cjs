/**
 * Globals jsdom omits but browsers have.
 *
 * `TextEncoder`/`TextDecoder` are the ones that matter here:
 * `@tanstack/router-core` touches them at *module load* (its SSR stream
 * serializer), so any test that imports the router fails to even parse
 * without them — with a `ReferenceError` pointing at the import line rather
 * than at anything the test does.
 *
 * Loaded via `setupFiles` (before the test framework), not
 * `setupFilesAfterEnv`, because the failure happens during module
 * evaluation. Harmless under the default `node` environment, where these
 * already exist — the assignments are guarded.
 */
const { TextEncoder, TextDecoder } = require('node:util');

if (typeof globalThis.TextEncoder === 'undefined') {
  globalThis.TextEncoder = TextEncoder;
}
if (typeof globalThis.TextDecoder === 'undefined') {
  globalThis.TextDecoder = TextDecoder;
}

// jsdom has no layout, so `scrollTo` throws "Not implemented" and floods the
// output. The router calls it on every navigation, which would bury real
// failures under noise. Stubbed rather than silenced so a test could still
// assert on it.
if (typeof globalThis.window !== 'undefined' && !globalThis.window.scrollTo) {
  globalThis.window.scrollTo = () => {};
}

/**
 * jsdom implements no `PointerEvent` whatsoever.
 *
 * Without it, Testing Library's `fireEvent.pointerMove(el, { clientY })`
 * silently produces an event with **no coordinates** — a drag test then
 * computes `NaN` for the distance and passes or fails for the wrong reason.
 * The bottom sheet's drag-to-dismiss is exactly that kind of logic, so it
 * would otherwise be untestable rather than merely untested.
 *
 * `MouseEvent` already carries `clientX`/`clientY`, so subclassing it and
 * adding the pointer-specific fields is enough for event-level tests. It
 * does NOT emulate pointer *capture* semantics — nothing in jsdom does —
 * which is why Sheet.test.tsx asserts on `setPointerCapture` being called
 * rather than on its retargeting side effects.
 */
if (
  typeof globalThis.window !== 'undefined' &&
  typeof globalThis.window.PointerEvent === 'undefined'
) {
  class PointerEvent extends globalThis.window.MouseEvent {
    constructor(type, params = {}) {
      super(type, params);
      this.pointerId = params.pointerId ?? 0;
      this.pointerType = params.pointerType ?? 'touch';
      this.isPrimary = params.isPrimary ?? true;
      this.width = params.width ?? 1;
      this.height = params.height ?? 1;
      this.pressure = params.pressure ?? 0.5;
    }
  }
  globalThis.window.PointerEvent = PointerEvent;
  globalThis.PointerEvent = PointerEvent;
}
