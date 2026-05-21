---
label: Security Center
icon: shield
order: 840
description: Monitor login activity, active sessions, lockouts, and security events across the platform.
---

# Security Center

The Security Center gives administrators real-time visibility into authentication activity, active sessions, and security-related events across the platform. All data is read-only for security auditors; write actions require separate capabilities.

## Prerequisites

- **Capability:** Viewing the Security Center requires the **`SECURITY_READ`** platform capability
- **Session revocation:** Requires **`USER_MANAGE`** capability (admins cannot revoke their own session from this view)

## Accessing the Security Center

Navigate to **Admin → Security** to open the Security Center.

## Login Activity

The **Login activity** tab shows authentication events across the platform:

| Metric | Description |
|---|---|
| **Successes** | Successful login and MFA verification events |
| **Failures** | Failed password attempts |
| **MFA Failures** | Failed MFA code attempts |

**Time windows:** Choose from Last 1h, 6h, 24h, 72h, or 7d. Data is capped at 7 days and limited to the most recent 200 events per view.

**Aggregations:**
- **By IP** — success/failure counts per source IP address
- **By email** — success/failure counts per target email
- **Recent activity** — chronological list with timestamps, IP, user agent, and action type

Action tags are colour-coded:
- **Green** — successful login or MFA verification
- **Yellow** — failed MFA verification
- **Red** — failed login attempt

## Lockouts

The **Lockouts** tab displays accounts and IPs currently under temporary lockout due to failed login attempts.

**How lockouts work:**
- After **5 failed attempts** within **15 minutes**, the IP/email is locked out
- Lockouts reset automatically after the TTL expires
- Counters below the threshold show as "Warming" (not yet locked)

**Views:**
- **By IP** — lockouts tied to source IP addresses
- **By email** — lockouts tied to target email addresses

Each row shows the failure count, lock state (Locked/Warming), and time until reset.

## Rate-Limit Blocks

The **Rate-limit blocks** tab shows active throttle blocks from the rate limiting system.

When an identity exceeds its request bucket and a block duration is configured, the block appears here with:
- **Tracker** — the blocked identity (user or IP)
- **Throttler** — which rate limiter triggered the block
- **Remaining** — time until the block expires

By default, Weavestream uses a soft 60-second rolling window without hard blocks, so this list is typically empty.

## Active Sessions

The **Active sessions** tab lists every non-revoked, non-expired session across all users.

**Session details:**
- User name and email
- Role (super_admin, operator, client)
- MFA state (Off, Enabled, Enrolled, Pending)
- IP address and user agent
- Session start time

**Revoking sessions:**
1. Find the session in the list
2. Click **Revoke**
3. Confirm the action

The user will be signed out on their next request. Revocation is audited and cannot target your own session from this view (use your profile page instead).

## Egress Blocks

The **Egress blocks** tab tracks outbound HTTP requests that were blocked by the SSRF guard.

**Why requests are blocked:**
- Destination is a private IP range (10.x.x.x, 172.16-31.x.x, 192.168.x.x)
- Destination is loopback (127.x.x.x)
- Destination is link-local (169.254.x.x) — including cloud metadata endpoints
- Hostname resolves to any of the above

**Allowlisting:**
Operators can permit specific private ranges by setting the `EGRESS_ALLOWED_PRIVATE_CIDRS` environment variable (comma-separated CIDR list).

Each blocked request is logged with:
- Timestamp and resolved IPs
- Block reason and matched CIDR
- Source user agent

## Data Retention

| Data type | Retention |
|---|---|
| Login activity | Audit log retention (configurable) |
| Lockouts | Until TTL expires (Redis) |
| Throttle blocks | Until block expires (Redis) |
| Active sessions | Until revoked or expired |
| Egress blocks | Audit log retention (configurable) |

All Security Center reads are capped to prevent memory issues during high-volume events.
