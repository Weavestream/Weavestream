---
label: Alert System Setup
icon: bell
order: 850
description: Configure email alerts for expirations, uptime, and record lifecycle events.
---

# Alert System Setup

Weavestream ships **email-only** alerts. Each alert is a saved configuration with one or more recipient addresses, an optional **company scope**, and a **type** that determines when it fires.

## Prerequisites

1. **Capability:** The **Alerts** sidebar entry and `/admin/alerts` require the **`ALERT_MANAGE`** platform capability (operators without it are redirected away).
2. **SMTP:** Outbound mail must work. Configure SMTP under **Admin → Settings → Email** (enable outbound email, fill host/port/credentials, save, then use **Send test email** there).
3. **Worker:** Delivery uses a BullMQ queue (`alerts`). The worker process must be running so emails are sent and scheduled scans run; otherwise triggers may queue without delivery.

## Where to configure

**Admin → Alerts** — create, edit, enable/disable, archive, or **Test** configurations. Tests call the same SMTP path as real alerts.

## Alert types (five)

Each type is independent; pick the one that matches what you want to know about.

| Type | What it does |
|---|---|
| **Single expiration** | Sends **one email per matching item** when it enters the configured window (days before expiry). Expired items stay eligible so a missed scan can still notify. |
| **Expiration list** | Sends **one digest email per UTC calendar day** listing everything inside the window that day (deduped so frequent scans do not multiply emails). |
| **Website down** | Notifies when a **monitored domain** has `httpDownSince` set (HTTP check marked the site down). Recovery and a new outage gets a new notification because the dedup key includes the down-since timestamp. |
| **Record created/updated/deleted** | Fires when audit entries match your chosen **record types** (assets, articles, passwords, domains, or all) and **actions** (created, updated, deleted/archived, or any). Hooks run off the audit log when someone saves changes. |
| **Password created/updated** | Same pipeline as record events but **only password create/update** (vault passwords do not hard-delete; archive is not offered here). |

**Expiration sources** (single + list types): domain registrar (WHOIS), TLS certificate expiry on monitored domains, password `expiresAt`, and asset fields that are **DATE/DATETIME** with the layout option **`isExpiry`** enabled. You can restrict kinds per alert or choose **all**.

**Website down** respects **company scope**: only domains in that tenant when a company is selected; all monitored domains when left global.

## How firing works (two paths)

**Scheduled scan** — **Single expiration**, **Expiration list**, and **Website down** are evaluated when the repeatable **`alerts:scan`** job runs. By default the cron is **`*/5 * * * *`** (every five minutes), configurable via **`ALERTS_SCAN_CRON`** in environment; set it to **`off`** to disable scheduled scans (**real-time record/password alerts still fire**).

**Audit-driven** — **Record** and **Password** alerts subscribe to **`AuditLogService`**: after a matching audit row is persisted, Weavestream enqueues an **`alerts:send`** job with subject/body derived from that event (including resolved record and company labels where possible).

All sends go through **`EmailService`** on the worker; successful sends write an **`alert.fired`** audit entry with recipients and outcome.

## Deduplication (built-in)

Weavestream stores **`AlertTrigger`** keys so the same logical condition does not email repeatedly:

- **Record/password events:** keyed to the audit row and config (`audit:<auditId>:<configId>`).
- **Single expiration:** typically once per item per kind (`single:<kind>:<itemId>`) while **Stop alerting after the first trigger per item** is on; when off, the key includes the UTC date so you can receive repeats on subsequent days inside the window.
- **Expiration list:** once per config per UTC day (`list:<configId>:YYYY-MM-DD`).
- **Website down:** once per domain per outage episode (`web-down:<domainId>:<httpDownSince iso>`).

## Operations

- **Disable** toggles a config off without deleting it.
- **Archive** stops firing permanently for that row (soft-archive).
- Create/update/archive/test actions are audited (`alert.create`, `alert.update`, `alert.archive`, `alert.test`).
- Changing SMTP settings affects every alert email path — retest from **Settings → Email** after credential rotation.
