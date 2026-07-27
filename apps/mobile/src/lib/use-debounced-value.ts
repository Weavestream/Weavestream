import { useEffect, useState } from 'react';

/**
 * The trailing-debounce every type-to-search screen needs: the returned
 * value lags `value` by `delayMs` and only settles once typing pauses.
 *
 * Extracted for the Phase 3 search screen from the pattern already
 * proven in `features/assets/AssetReferencePicker.tsx` (which keeps its
 * own inline copy for now — refactoring it is out of Phase 3's scope).
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}
