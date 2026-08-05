---
label: Alert System Setup
icon: bell
order: 850
description: Configure email alerts for expirations, uptime, record lifecycle, and security events.
---

# Alert System Setup

Weavestream ships **email-only** alerts. Each alert is a saved configuration with one or more recipient addresses, an optional **company scope**, and a **type** that determines when it fires. Creating an alert is a two-step dialog: pick what to watch for from the type cards, then fill in the details.

## Prerequisites

1. **Capability:** The **Alerts** sidebar entry and `/admin/alerts` require the **`ALERT_MANAGE`** platform capability (operators without it are redirected away).
2. **SMTP:** Outbound mail must work. Configure SMTP under **Admin → Settings → Email** (enable outbound email, fill host/port/credentials, save, then use **Send test email** there).
3. **Worker:** Delivery uses a BullMQ queue (`alerts`). The worker process must be running so emails are sent and scheduled scans run; otherwise triggers may queue without delivery.

## Where to configure

**Admin → Alerts** — create, edit, enable/disable, archive, or **Test** configurations. Tests call the same SMTP path as real alerts.

## Alert types (eight)

Each type is independent; pick the one that matches what you want to know about.

| Type | What it does |
|---|---|
| **Single expiration** | Sends **one email per matching item** when it enters the configured window (days before expiry). Expired items stay eligible so a missed scan can still notify. |
| **Expiration list** | Sends **one digest email per UTC calendar day** listing everything inside the window that day (deduped so frequent scans do not multiply emails). |
| **Website down** | Notifies when a **monitored domain** has `httpDownSince` set (HTTP check marked the site down). Recovery and a new outage gets a new notification because the dedup key includes the down-since timestamp. |
| **Record created/updated/deleted** | Fires when audit entries match your chosen **record types** (assets, articles, passwords, domains, or all) and **actions** (created, updated, deleted/archived, or any). Hooks run off the audit log when someone saves changes. |
| **Password created/updated** | Same pipeline as record events but **only password create/update** (vault passwords do not hard-delete; archive is not offered here). |
| **Repeated failed sign-ins** | Fires the moment failed sign-in attempts for one IP **or** one account reach the lockout threshold — i.e. exactly when the sign-in lockout engages. |
| **IP blocked or rate limited** | Fires when a request is denied by a **DENY IP rule** (API or page layer), when a **rate limiter** rejects requests, or when the sign-in lockout engages. |
| **Suspicious account behavior** | Fires immediately on **refresh-token reuse** (possible session theft) and **step-up anomalies**, and at the lockout threshold for repeated **MFA**, **step-up**, or **password-change** verification failures. |

The last three are the **security alerts** — see the dedicated section below.

**Expiration sources** (single + list types): domain registrar (WHOIS), TLS certificate expiry on monitored domains, password `expiresAt`, and asset fields that are **DATE/DATETIME** with the layout option **`isExpiry`** enabled. You can restrict kinds per alert or choose **all**.

**Website down** respects **company scope**: only domains in that tenant when a company is selected; all monitored domains when left global.

## Security alerts

The three security types watch the platform itself rather than customer records, so they are **always global** — the company scope field is hidden for them, and the only settings are name, recipients, and enabled state.

**What triggers each type:**

- **Repeated failed sign-ins** — driven by `auth.login.failure` audit events. Weavestream already locks sign-in after **`LOCKOUT_MAX_FAILURES`** failures (default 5) per IP or per account within **`LOCKOUT_WINDOW_MIN`** minutes (default 15); this alert emails at exactly the moment a counter reaches that threshold. One email per lockout episode — once locked, further attempts are rejected before they can count, so the threshold is crossed at most once per window.
- **IP blocked or rate limited** — three sources: a request denied by a **DENY** rule in **Admin → Security → IP rules** (both the API guard and the web page layer report these — page-load denials never reach the API, so the web tier reports them through an internal endpoint); a rejection by the global or sign-in **rate limiter**; and the sign-in lockout engaging (the same event as above, so one incident can notify both types if you enabled both). IP-rule and rate-limit events are coalesced at the source — one audit entry (and one email) per blocked IP + rule per lockout window, and one per rate-limited client per block window — so a hostile client hammering at request rate cannot flood the audit log or your inbox.
- **Suspicious account behavior** — immediate for `auth.refresh.reused` (a revoked refresh token was presented again — the classic stolen-session signal) and `security.stepup.anomaly` (an account flagged MFA-enabled with no stored secret; this is a persistent misconfiguration, so it emails at most once per user per UTC day). Threshold-based, using the same lockout threshold, for repeated MFA verification failures, step-up verification failures, and password-change verification failures.

**What the emails contain:** the alert name, a plain-language event description, UTC timestamp, source IP, the known account identity (attempted email or resolved user), user agent, the matched rule CIDR or limiter/limit/retry details, failure counts with the window, and the audit event id. They deliberately never include request bodies, credentials, codes, tokens or token hashes, cookies, or session identifiers. The email is a pointer, not the record — the audit log and **Admin → Security** remain the source of truth, and every trigger is visible there even if an email is lost.

**Delivery guarantees:** the *emails* are best-effort by design, but the underlying protections are not — failure-counter writes fail closed (an authentication attempt errors rather than proceeding uncounted if Redis breaks mid-request), and every trigger stays in the audit log whether or not an email was delivered. Only the notification layer (the coalescing gate and queue delivery) degrades quietly.

**Scheduled scan** — **Single expiration**, **Expiration list**, and **Website down** are evaluated when the repeatable **`alerts:scan`** job runs. By default the cron is **`*/5 * * * *`** (every five minutes), configurable via **`ALERTS_SCAN_CRON`** in environment; set it to **`off`** to disable scheduled scans (**real-time record/password alerts still fire**).

**Audit-driven** — **Record**, **Password**, and all three **security** alerts subscribe to **`AuditLogService`**: after a matching audit row is persisted, Weavestream enqueues an **`alerts:send`** job with subject/body derived from that event (including resolved record and company labels where possible). Security matching is fully separate from record matching — a record alert set to "all record types" never receives security events, and vice versa.

All sends go through **`EmailService`** on the worker; successful sends write an **`alert.fired`** audit entry with recipients and outcome.

## Deduplication (built-in)

Weavestream stores **`AlertTrigger`** keys so the same logical condition does not email repeatedly:

- **Record/password events:** keyed to the audit row and config (`audit:<auditId>:<configId>`).
- **Single expiration:** typically once per item per kind (`single:<kind>:<itemId>`) while **Stop alerting after the first trigger per item** is on; when off, the key includes the UTC date so you can receive repeats on subsequent days inside the window.
- **Expiration list:** once per config per UTC day (`list:<configId>:YYYY-MM-DD`).
- **Website down:** once per domain per outage episode (`web-down:<domainId>:<httpDownSince iso>`).
- **Security events:** keyed to the audit row like record events, with two extra layers — IP-block and rate-limit events are already coalesced at the source (one audit row per subject per window), and step-up anomalies use a per-user per-UTC-day key (`sec:anomaly:<userId>:YYYY-MM-DD`).

## Operations

- **Disable** toggles a config off without deleting it.
- **Archive** stops firing permanently for that row (soft-archive).
- Create/update/archive/test actions are audited (`alert.create`, `alert.update`, `alert.archive`, `alert.test`).
- Changing SMTP settings affects every alert email path — retest from **Settings → Email** after credential rotation.
