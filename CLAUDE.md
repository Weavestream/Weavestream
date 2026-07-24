# Project Rules

## App Development Standards

- Before adding new helpers, components, formatting logic, or utilities, search the codebase for an existing common/global function or component and reuse it when it fits.
- Do not duplicate behavior that already exists in shared modules. Prefer extending the existing shared abstraction only when the use case is genuinely reusable.
- When adding a table in the web app, use the global table standard: `DataTable`, `DataColumn`, and `MobileCardRow` from `apps/web/src/components/ui`.
- Follow the existing assets table pattern in `apps/web/src/app/admin/companies/[id]/assets/assets-table.tsx`: define typed columns, provide sort values where useful, set sensible column widths, and supply `renderMobileCard` for mobile.
- Do not add one-off table markup unless the global table cannot support the use case; if so, explain why in the change.
- When adding a new page or major page section, include mobile view optimization as part of the implementation. Ensure filters/actions wrap cleanly, dense content has a mobile-friendly layout, and tables/cards remain usable on narrow screens.

---

## Security

You are working on a security-sensitive application. The rules below are not suggestions. When a rule conflicts with brevity, convenience, or "the way it's usually done," the rule wins. If you cannot follow a rule, stop and explain why rather than working around it.

### 1. Authorization & Access Control

- Never create a function, endpoint, or query that can bypass a user's permission level, role, or tenant scope. Every data-access path must take the acting user/tenant as a parameter and filter on it at the query layer, not in application code after the fact.
- Never trust a tenant_id, org_id, user_id, or role value that came from the client (request body, query string, header, JWT claim that isn't signature-verified server-side). Derive it from the authenticated session on the server.
- Authorization checks belong at the entry point of every handler. Do not rely on "the caller already checked." If you write a new handler, write the check.
- IDOR is the default failure mode. Any endpoint that accepts an ID (`/things/:id`) must verify the acting user is permitted to see *that specific* ID before returning it. "Knowing the ID" is never authorization.
- Admin/superuser/impersonation paths require a separate, explicit check — never a boolean flag on the user object alone. Log every use.
- Multi-tenant queries: tenant scoping is a `WHERE` clause, not a code review comment. If an ORM call doesn't include the tenant filter, it's a bug.

### 2. Secrets, Credentials & Sensitive Data

- Never hardcode secrets, API keys, tokens, connection strings, or passwords — not in source, not in tests, not in comments, not in commit messages, not in example values. Use environment variables or the project's secret manager.
- Never log secrets, full tokens, passwords (hashed or otherwise), bearer session/refresh/access tokens (the raw cookie values), full credit card numbers, full SSNs, or raw PII. When logging is needed, redact: show last 4 chars or a SHA-256 prefix, never the value.
  - Clarification (what "session ID" means here): the prohibition covers **bearer credentials** — anything a client presents to authenticate (the raw refresh token in the session cookie, the signed access-token JWT). It does **not** cover the opaque server-side session *row id* (`Session.id`, a random UUID). That id is never a credential — clients authenticate with a signed JWT or a hashed refresh token, never with the row id — so it is inert on its own, in the same class as `userId`. Recording it in the **audit trail** for session correlation (e.g. which session performed or attempted an action, which session was kept on a password change) is expected and encouraged. The redaction rule still applies to the bearer tokens above; it does not apply to `Session.id`.
- Never echo a secret back in an API response, even on the endpoint that just set it. Return success/failure, not the value.
- Passwords at rest: Argon2id (preferred) or bcrypt with cost ≥ 12. Never MD5, SHA-1, SHA-256, or any unsalted hash for passwords.
- Symmetric encryption: AES-256-GCM with a unique nonce per encryption. Never ECB. Never reuse a nonce. Never roll your own crypto primitives.
- Key material lives in a KMS, vault, or environment — never in the database next to the data it encrypts.

### 3. Input Handling & Injection

- SQL: parameterized queries or a query builder, every time. String concatenation or template literals into SQL is forbidden, even for "internal" or "trusted" values.
- Shell/OS commands: never pass user input through `exec`, `system`, `eval`, `child_process.exec`, `os.system`, backticks, or `shell=True`. Use argument arrays (`execFile`, `subprocess.run([...], shell=False)`) and validate inputs against an allowlist.
- Path handling: never join user input directly into a filesystem path. Resolve, then verify the resolved path is inside the expected base directory (path traversal check). Reject symlinks unless explicitly intended.
- Deserialization: never deserialize untrusted data with pickle, Java serialization, PHP unserialize, YAML.load (use safe_load), or `Function()`/`eval()` in JS. JSON only, with a schema.
- SSRF: outbound HTTP from user-supplied URLs must validate the resolved IP is not in private ranges (RFC1918, loopback, link-local, IPv6 ULA/link-local, metadata endpoints like 169.254.169.254). Re-resolve after redirects.
- Server-rendered HTML: use the framework's auto-escaping. Never construct HTML with string concatenation. `innerHTML`, `dangerouslySetInnerHTML`, `v-html`, and equivalents require justification in a comment.

### 4. Authentication & Sessions

- Session tokens and CSRF tokens: cryptographically random (`crypto.randomBytes` / `secrets.token_urlsafe`), never `Math.random`, never timestamp-based.
- Cookies carrying auth: `HttpOnly`, `Secure`, `SameSite=Lax` minimum (Strict where the UX permits). Never put session tokens in `localStorage`.
- Comparisons of secrets, tokens, MACs, or signatures: constant-time (`crypto.timingSafeEqual`, `hmac.compare_digest`). Never `==` or `===`.
- Account lockout, rate limiting, and brute-force protection on every authentication endpoint, including password reset and MFA verification.
- Password reset tokens: single-use, ≤ 1 hour expiry, invalidated on use and on password change. Never reveal whether an email exists in the reset flow.

### 5. Dependencies & Libraries

- When adding a new dependency, fetch the *current* latest stable version rather than using a version from training data. Check the registry (npm, PyPI, crates.io, etc.) at the moment of adding. Pin to that version in the lockfile.
- Prefer libraries with recent commits, multiple maintainers, and a documented security policy. Flag any new dependency that hasn't been updated in 18+ months.
- Never add a dependency for a one-liner. `is-odd`-class packages are a supply-chain risk multiplier.
- When you update an existing dependency, check its changelog/security advisories for breaking changes and CVEs between the old and new version. Note any in the PR description.
- Pin Docker base images by digest (`@sha256:...`), not just by tag, for production images.
- Never introduce a dependency under a license incompatible with AGPL-3.0.

### 6. Error Handling & Logging

- Never `catch` an exception and silently swallow it. Either handle it meaningfully or re-raise. Empty catch blocks require a comment explaining why.
- Error responses to clients: generic message + correlation ID. Stack traces, SQL errors, file paths, and internal hostnames never go to the client.
- Server logs include: timestamp, correlation/request ID, acting user/tenant (ID, not name), action, outcome. Audit-relevant actions (login, permission change, data export, admin action, credential access) go to a separate append-only audit log.
- Log levels mean things: DEBUG = developer only, INFO = normal operation, WARN = anomaly worth review, ERROR = something broke, CRITICAL = page someone. Don't log routine traffic at WARN+.

### 7. AI / LLM-Specific Rules

- Treat all model output as untrusted input. Validate, schema-check, and sanitize before using it in queries, shell commands, file paths, or rendered HTML.
- Prompts that include user-controlled text must mark it as data, not instructions (delimiters, structured input). Assume prompt injection is attempted.
- Never send secrets, PII, or customer data to a third-party model API without explicit authorization for that data class.
- Tool-calling agents: every tool the model can invoke must enforce the same authorization as if a user called it directly. The model is not a trusted principal.

### 8. Code Change Discipline

- Every significant change must be appended to `CHANGELOG-SECURITY.md`. "Significant" = any new function/endpoint, any change to auth/authz/crypto/data-access, any new dependency, any change to a security-relevant config.
- When modifying an existing function, do not silently change its security properties (e.g. loosening a check, broadening a query, removing a filter). If you must, call it out explicitly and log it.
- Do not generate code that disables security tooling (linters, type checkers, CSP, SAST rules) to make a test pass. Fix the underlying issue.
- If you're unsure whether something is safe, say so and ask. A pause is cheaper than a CVE.
- `CHANGELOG-SECURITY.md` is intentionally excluded from git via `.gitignore`.

---
