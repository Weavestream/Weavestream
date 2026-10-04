/**
 * Supported API surface for `apps/worker`: the environment-file bootstrap.
 *
 * A side-effect entry, separate from `runtime.ts`, because it must be the
 * first import of a process entry point — before any module that reads env.
 * See `../load-env.ts` for the behavior.
 */
import '../load-env.js';
