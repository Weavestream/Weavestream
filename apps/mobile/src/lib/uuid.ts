/**
 * Cheap UUID shape check for untrusted identifier inputs — localStorage
 * values, URL search params, and route params. Not a validator of
 * *existence*; the server re-derives authorization on every request
 * regardless. What this buys the client:
 *
 *  - a malformed deep link (`/m/articles/abc`) renders the not-found
 *    state instead of firing a request that 400s and looks retryable;
 *  - a tampered `?folder=` search param is dropped instead of forwarded.
 */
export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
