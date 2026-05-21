---
label: Client Portal Setup
icon: browser
order: 840
description: Configure what your clients can see in their read-only portal.
---

# Client Portal Setup

This guide walks through setting up a client portal for a tenant — from configuring visibility flags to creating client user accounts.

## Overview

Each tenant in Weavestream has a client portal at `/portal/<company-slug>`. The portal shows a curated subset of the tenant's data, controlled by `visibleToClients` flags set by operators.

## Step 1 — Decide what to expose

Before adding client users, decide which content you want them to see. Use the table below as a planning checklist:

| Content type | Where to configure |
|---|---|
| Articles | Per-article toggle in the article editor or list |
| Asset fields | Per-field toggle in the Asset Layout builder |
| Passwords | Per-password toggle on the credential detail page |
| Domains | Per-domain toggle on the domain detail page |

Start with a conservative configuration — expose only what the client actively needs — and expand over time.

## Step 2 — Mark articles as visible

1. Open the tenant's **Articles** section
2. For each article you want to expose: open the article, toggle **Visible to clients** to on
3. Alternatively, toggle visibility from the article list view

!!!tip Folder structure
Create a dedicated folder (e.g. "Client Documentation") for articles intended for clients. This makes it easy to see at a glance what is exposed.
!!!

## Step 3 — Configure asset field visibility

Asset field visibility is set in the **Layout Builder**, not per-asset:

1. Go to **Admin → Layouts**
2. Open the relevant layout
3. For each field, toggle **Visible to clients**

Fields with this toggle off are stripped from the response before it reaches the browser — even if a client inspects their network traffic, they cannot see hidden field values.

!!!warning Field visibility is layout-wide
Toggling a field's client visibility affects that field across **all tenants** using that layout. If you need different visibility per tenant, consider creating separate layouts.
!!!

## Step 4 — Add client users

1. Navigate to **Admin → Users → New User**
2. Set the global role to `CLIENT_USER`
3. Copy the setup link and send it to the client

Once the client completes setup (sets their password and enrolls MFA), grant them access to the tenant:

1. Go to **Admin → Memberships** or the tenant's settings
2. Add a membership for the client user
3. Set the role to `CLIENT_VIEWER` (read-only) or `CLIENT_ADMIN` (can manage other client users)

## Step 5 — Test the portal

Log out of your admin account and log in as the client user to verify the portal shows exactly what you intend. Alternatively, open the portal URL in a private/incognito window.

The portal URL is: `https://your-instance.com/portal/<company-slug>`

The company slug is shown on the tenant's settings page.

## Updating Visibility Later

You can change visibility flags at any time. Changes take effect immediately on the next page load — no cache clearing required.

If you remove a client user's membership, their access is revoked on the next request (no grace period). Active sessions are invalidated immediately.

## Client Portal Capabilities

| Action | CLIENT_VIEWER | CLIENT_ADMIN |
|---|---|---|
| Read visible articles | ✓ | ✓ |
| Read visible asset fields | ✓ | ✓ |
| Reveal visible passwords | ✓ | ✓ |
| View domain check history | ✓ | ✓ |
| Manage client users | ✗ | ✓ |
| Create or edit content | ✗ | ✗ |
| Access admin interface | ✗ | ✗ |
