---
label: Features
icon: stack
order: 800
description: Reference pages for Weavestream's major modules and platform features.
---

# Feature Reference

Use this section as a module reference for Weavestream. Each page explains what the feature does, how data is structured, what permissions apply, and where the feature fits into the rest of the platform.

## Documentation Records

[!card title="Company Management" text="Tenant records, contact details, addresses, logos, notes, parent-child hierarchy, type classification, and configurable terminology." icon="organization" layout="compact"](/features/companies/)
[!card title="Asset Management" text="Custom asset layouts, field types, layout options, asset records, expiration tracking, search, and relationships." icon="server" layout="compact"](/features/assets/)
[!card title="Documentation" text="Tenant articles authored in rich text or Markdown, organised into folders, searchable, and optionally exposed to clients." icon="note" layout="compact"](/features/articles/)
[!card title="Files & Photos" text="Per-tenant file storage, supported upload types, thumbnails, photo galleries, metadata, and asset field attachments." icon="file" layout="compact"](/features/files/)

## Credentials And Infrastructure

[!card title="Password Vault" text="Encrypted credential records with TOTP secrets, breach checks, generator support, access restrictions, and version history." icon="lock" layout="compact"](/features/passwords/)
[!card title="Domain & SSL Monitoring" text="WHOIS, DNS, HTTP, and TLS checks for monitored hostnames, with history and expiration tracking." icon="globe" layout="compact"](/features/domains/)
[!card title="IP Address Management (IPAM)" text="Tenant-scoped IPv4 subnets, occupancy detection, reservations, conflict detection, and address-space visualization." icon="table" layout="compact"](/features/ipam/)
[!card title="Integrations" text="Built-in integration drivers for syncing external inventory into tenant asset records on demand or on a schedule." icon="plug" layout="compact"](/features/integrations/)

## Access, Visibility, And Audit

[!card title="Users & RBAC" text="Invite-only users, forced MFA, global roles, tenant memberships, default tenant access, and platform capabilities." icon="person" layout="compact"](/features/users/)
[!card title="Client Portal" text="Read-only tenant portal for client users, with server-side field scoping and per-record visibility controls." icon="browser" layout="compact"](/features/client-portal/)
[!card title="Audit & Compliance" text="Append-only audit history, before/after diffs, password reveal audit events, retention expectations, and compliance use cases." icon="shield-check" layout="compact"](/features/audit/)

## Navigation And Assistance

[!card title="Search" text="PostgreSQL full-text search across articles, assets, and uploads, plus command palette behaviour and indexed content." icon="search" layout="compact"](/features/search/)
[!card title="Starred Items" text="Per-user bookmarks for companies, assets, passwords, and articles, available from the sidebar and dashboard." icon="star" layout="compact"](/features/starred/)
[!card title="AI Chat" text="OpenAI-compatible chat panel with persistent conversations, explicit context attachment, and article editing support." icon="hubot" layout="compact"](/features/ai-chat/)

## Related Docs

- [Key concepts](/overview/concepts/) — terminology and core data model
- [Architecture](/overview/architecture/) — services, request flow, RBAC, and data layout
- [Guides](/guides/) — task-oriented walkthroughs for common workflows
- [Changelog](/overview/changelog/) — release notes and feature changes
