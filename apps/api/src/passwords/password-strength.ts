import { zxcvbnOptions, zxcvbn } from '@zxcvbn-ts/core';
import * as zxcvbnCommon from '@zxcvbn-ts/language-common';
import * as zxcvbnEn from '@zxcvbn-ts/language-en';

let configured = false;

function ensureConfigured(): void {
  if (configured) return;
  zxcvbnOptions.setOptions({
    translations: zxcvbnEn.translations,
    graphs: zxcvbnCommon.adjacencyGraphs,
    dictionary: {
      ...zxcvbnCommon.dictionary,
      ...zxcvbnEn.dictionary,
    },
  });
  configured = true;
}

/**
 * Returns zxcvbn's 0..4 crack-time bucket for `plaintext`. Kept outside
 * the service class so it can be reused by CLI / tests without pulling
 * in the DI graph. `extraInputs` is an array of user-supplied context
 * (name, username, url) — zxcvbn penalises passwords that echo back
 * these obvious guesses.
 */
export function computePasswordStrength(
  plaintext: string,
  extraInputs: string[] = [],
): number {
  ensureConfigured();
  const result = zxcvbn(plaintext, extraInputs.filter(Boolean));
  return result.score;
}
