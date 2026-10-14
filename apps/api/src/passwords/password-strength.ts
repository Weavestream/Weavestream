import { ZxcvbnFactory } from '@zxcvbn-ts/core';
import * as zxcvbnCommon from '@zxcvbn-ts/language-common';
import * as zxcvbnEn from '@zxcvbn-ts/language-en';

let factory: ZxcvbnFactory | undefined;

function getFactory(): ZxcvbnFactory {
  factory ??= new ZxcvbnFactory({
    translations: zxcvbnEn.translations,
    graphs: zxcvbnCommon.adjacencyGraphs,
    dictionary: {
      ...zxcvbnCommon.dictionary,
      ...zxcvbnEn.dictionary,
    },
  });
  return factory;
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
  const result = getFactory().check(plaintext, extraInputs.filter(Boolean));
  return result.score;
}
