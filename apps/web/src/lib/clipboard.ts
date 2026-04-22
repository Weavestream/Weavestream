/**
 * Copy a plain text string to the clipboard.
 *
 * Use this when the text is *already resolved* before the click
 * handler runs (e.g. copying a field value off a React prop). If you
 * still need to fetch the text asynchronously, use `copyWithPromise`
 * instead — otherwise the awaited fetch consumes the user-gesture
 * token and the clipboard write gets rejected.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (
      typeof navigator !== 'undefined' &&
      navigator.clipboard &&
      typeof window !== 'undefined' &&
      window.isSecureContext
    ) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the execCommand path
  }
  return execCommandFallback(text);
}

/**
 * Copy a value that has to be fetched asynchronously (e.g. a decrypted
 * password or a one-time code) without losing the user-gesture token.
 *
 * Browsers require `navigator.clipboard.write` to be called
 * synchronously inside a click handler. Once we `await fetch(...)` the
 * gesture is gone and the call is rejected — which is what was
 * producing the "Clipboard unavailable" toast even when the fetch
 * succeeded.
 *
 * `ClipboardItem` accepts a `Promise<Blob>` and queues the clipboard
 * write against the *current* gesture; Safari 13.4+ and Chromium both
 * support this pattern. See:
 * https://webkit.org/blog/10855/async-clipboard-api/
 *
 * We still expose a writeText fallback for browsers that implement
 * `clipboard.writeText` but not `clipboard.write` (older Firefox), and
 * an `execCommand('copy')` fallback of last resort.
 */
export async function copyWithPromise(
  provider: () => Promise<string>,
): Promise<boolean> {
  if (
    typeof navigator !== 'undefined' &&
    navigator.clipboard &&
    typeof window !== 'undefined' &&
    window.isSecureContext &&
    typeof ClipboardItem !== 'undefined' &&
    typeof navigator.clipboard.write === 'function'
  ) {
    try {
      const blobPromise = provider().then(
        (text) => new Blob([text], { type: 'text/plain' }),
      );
      // Call synchronously so the browser ties the write to this
      // click's gesture token. The promise resolves later without
      // losing activation.
      await navigator.clipboard.write([
        new ClipboardItem({ 'text/plain': blobPromise }),
      ]);
      return true;
    } catch {
      // Fall through and try the writeText path. If the provider
      // itself already failed we'll bail out cleanly below.
    }
  }

  try {
    const text = await provider();
    return await copyToClipboard(text);
  } catch {
    return false;
  }
}

function execCommandFallback(text: string): boolean {
  try {
    if (typeof document === 'undefined') return false;
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-9999px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
