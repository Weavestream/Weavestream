# Audit trail and security administration

## Review the audit trail
<!-- aliases: audit log | change history | who changed asset | password reveal log | audit filters | compliance log -->
<!-- requires: audit.read -->

Open **Admin → Audit** to review the append-only history of mutations. Filter by date range, actor, action, and entity type; the filters persist in the URL for sharing and bookmarking. Open an entry to inspect its before/after record diff, affected company, actor, time, IP attribution, and user agent.

The audit trail records creates, updates, archives, restores, deletes, and other relevant actions. Password reveals are separately recorded as reveal events with metadata only: plaintext secrets are never written to the audit log. Audit history is not editable or deletable through the app; use it to investigate an event, not to undo a change. Restore archived records or prior article versions through the relevant record UI instead.

## Use the Security Center to investigate access events
<!-- aliases: security center | login activity | lockouts | active sessions | rate limit blocks | egress blocks | revoke session -->
<!-- requires: security.read -->

Open **Admin → Security** to inspect security-relevant operational data, including login activity, account lockouts, rate-limit blocks, active sessions, and blocked outbound connection attempts. Use date/user filters and open the underlying context before taking action.

For a suspicious active session, revoke it from the security/session controls; the next request using that session is rejected. For a locked account, verify the actor and cause before clearing a lockout. A rate-limit or egress block is evidence of a protective control; do not repeatedly retry the blocked action. Escalate unusual activity through your organization’s incident process and use the audit log to correlate record changes.

## Manage global IP access rules carefully
<!-- aliases: IP rules | allow IP address | deny IP address | block IP | office IP allowlist | IP access control -->
<!-- requires: ip_rule.manage -->

Open **Admin → IP Rules** to create, edit, enable/disable, or remove global allow/deny rules for client IP ranges. Specify the intended address or CIDR precisely, choose the effect, and document the operational reason in the rule description when the UI provides one. Rules apply globally; they are not a substitute for company-level authorization.

Before saving a deny or allow rule, confirm it will not block your administrators, reverse proxy, VPN, or approved support path. Test access from an authorized location after a change. If an IP rule unexpectedly blocks access, use your organization’s approved break-glass or host-administration procedure; product help does not provide server-level recovery steps.

## Manage workspace-wide settings without changing access scope
<!-- aliases: settings | workspace name | tenant terminology | password generator defaults | email settings | AI settings -->
<!-- requires: settings.manage -->

Open **Admin → Settings** to manage workspace branding/terminology, password-generator defaults, outbound email settings, and AI provider settings. Branding and tenant terminology change UI wording only; they do not rename URLs, data, integrations, permissions, or audit records.

Use the email test action after authorized email configuration changes, because alert delivery depends on the same mail path. Change AI configuration only after confirming the provider is approved for the kind of company data that may be attached to chat. These settings are global, so a change affects the workspace rather than one company.
