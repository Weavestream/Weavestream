---
label: Google Workspace
icon: plug
description: Connect Google Workspace tenants with one click to sync people, devices and groups into your layouts, with licences and storage on the asset page, and the tenant's domains into Domains monitoring.
---

# Google Workspace Integration

**Google Workspace** is Google's suite of business email, storage and collaboration apps, managed from the Google Admin console.

The Weavestream Google Workspace driver is **read-only**. A Weavestream install has **one** Google Workspace integration. Its **App** tab holds the one Google Cloud OAuth app for your install, and its **Connections** tab holds one connection per customer tenant, each made with a single Google sign-in by one of their admins.

## Overview & Features

- **One-click connect per customer**: no per-customer Google Cloud project, no service account keys.
- **Match first**: on the first sync, Google records link to the assets you already have (users by email, devices by serial number). An asset is only created when nothing matches.
- **Standard facts fill your layout fields**: job title, department and phone for people; model, operating system, MAC and IP address for devices; and a few more per resource (see below). You pick or create the fields in **Map layouts**. Everything else (licences, storage, 2-step verification, org unit, device status) shows in a **Google Workspace** section on the asset page.
- **Your edits win**: a field someone changed in Weavestream is never overwritten. It is listed as a **difference** instead, and you choose which value to keep.
- **Usage bars**: mailbox, Drive and total storage per user, and pooled storage for the tenant, shown as bars that turn amber at 80% and red at 95%.
- **Built-in setup guide and Check setup**: the steps below are also shown inside Weavestream, and **Check setup** points to the step that needs fixing.

## Synced Data Reference

| Resource | Suggested layout | Matched on | Layout fields filled (when mapped) | Google Workspace section on the asset page |
|---|---|---|---|---|
| **Tenant** | Google Workspace Tenants (created) | Customer ID | Name, Customer ID, Primary domain | Overview (active, suspended and archived users, created), Licences assigned per edition, Storage (used vs pooled, with Gmail, Drive and shared drives, data as of), Security (2-step verification coverage, super admins, unused licences) |
| **Users** | People | Email | Name, Email, Job title, Department, Phone | Account (status, **org unit**, created, last login), Licences, Mailbox, Drive, Total storage, Security (admin role, 2-step verification, unused licence) |
| **Groups** | Distribution Lists | Email | Name, Email, Description | Group (member count, members) |
| **Chrome devices** | Laptops, Chromebooks or Workstations | Serial number | Name, Serial number, Model, Operating system, MAC address, IP address (and optionally Auto-update expiration) | Chrome OS (status, last sync, last user, org unit, auto-update expiration) |
| **Mobile devices** | Phones | Serial number | Name, Serial number, Model, Manufacturer, Operating system, IMEI, MAC address | Device (type, owner, status, last sync, compromised) |

### Domains feed Domains monitoring

The tenant's domains are not assets. On every sync of a mapped tenant, its **verified** domains and domain aliases go to the company's built-in **Domains** monitoring (WHOIS, DNS and TLS checks), and each domain shows a **Google Workspace** tag in the Domains list and a **Google Workspace** card on its page with the role (**Primary domain**, **Secondary domain**, or **Domain alias of** its parent domain), verification, last sync and the integration.

- **Matched, never duplicated.** A Google domain is matched to a domain the company already monitors by name (ignoring upper and lower case and a trailing dot), whether it was added by hand or synced from Cloudflare. A match only gains the Google Workspace details: its checks, client visibility and, for a Cloudflare domain, the registrar details are left as they are. Cloudflare wins on anything both provide.
- **New domains** are added to the mapped company with the default checks, like **New domain**, and get their first check right away.
- **Archived domains are left alone.** An archived domain is not restored, and no second copy is added beside it.
- **Google's default domains are skipped**: the `*.test-google-a.com` test alias (and any `*.googleapps.com` domain) that Google creates for a tenant. Unverified domains are skipped too.
- **A domain removed from Workspace** (or no longer verified) is never deleted: its role is cleared and the card and tag show **not in Google Workspace since** the date it disappeared.
- **Only the mapped company.** A tenant's domains only ever touch the company the tenant is mapped to.
- Domains are synced after the mapping's resources, on real runs only (not on a dry run). A failure is shown as a warning on the run and never fails it.

How each layout field is filled:

| Layout field | Value | Example |
|---|---|---|
| **Job title** | Title of the user's primary organization (else the first) | `Engineer` |
| **Department** | Department of that same organization | `Operations` |
| **Phone** | The primary phone, else the work phone, else the first, as an international number; a number with letters (such as an extension) is skipped | `+15550100199` |
| **Description** | Group description, as plain text | `All staff` |
| **Model** | Device model | `Example Chromebook` |
| **Manufacturer** | Phone brand, else manufacturer | `Example` |
| **Operating system** | `ChromeOS` and the OS version for Chrome devices; the reported OS for phones | `ChromeOS 128.0`, `Android 15` |
| **MAC address** | Chrome device MAC, or the phone's Wi-Fi MAC, as `aa:bb:cc:dd:ee:ff` | `00:11:22:aa:bb:cc` |
| **IP address** | Last known local IP of a Chrome device | `192.0.2.10` |
| **IMEI** | Phone IMEI | `490154203237518` |
| **Primary domain** | The tenant's primary domain | `example.com` |

A value Google does not report is left alone: the field is never cleared. The **org unit** stays in the section (it is managed in Google), and a Chrome device's **last user** is only shown there: it never fills an assigned-to field. Fields you own (asset tag, status, location, assigned user, purchase, warranty, notes and the like) are never written.

### How Google updates your fields

- **First sync of a record** (a new asset, or an existing asset it adopts): Google writes every mapped field.
- **Later syncs**: an empty field is filled. A field that still holds the value Google wrote last follows Google, so a new job title or OS version flows through.
- **A field you map later** on a record Google already syncs: an empty one is filled; one that already holds a value is listed under **Differences** instead of being overwritten.
- **A field someone changed** is not overwritten. When it differs from Google, it is listed under **Differences** at the bottom of the Google Workspace section, with the Weavestream value and the Google value:
  - **Use Google Workspace value** writes the Google value now, and the field follows Google again.
  - **Keep ours** keeps your value and stops flagging that field on that record until the Google value changes again.
- Every open difference across all companies is also listed on the integration's **Differences** tab (**Admin > Integrations > your Google Workspace integration**), filterable by company, with the same two buttons. Tick several rows (or **Select all** matching the company filter) to resolve them in one go; the tab confirms first and then lists what was applied, skipped or failed. Resolving a difference needs permission to edit assets in that company and is recorded in the audit log. Differences are never shown to client users.

Chromebook **auto-update expiration** can optionally be mapped to a date field marked as an expiry, so it shows up in **Expiring soon**.

### What Google cannot provide

- **No bill, purchased seat count or renewal date** for customers you do not resell. Google only exposes *assigned* licences. Invoices are only in the Admin console.
- **No size per shared drive.** Only the tenant total for all shared drives is available.
- **Usage data lags 1–3 days.** Storage figures come from Google's usage reports, which Google publishes with a delay. The section shows the date the figures are from.
- **Licences cover Google Workspace and Education only.** Weavestream reads the Google Workspace product (all business editions, Education Fundamentals), Education Standard and Plus, and the Teaching and Learning Upgrade. Other products (for example Cloud Identity Premium or Google Voice) are not listed.
- **No security alerts.** Google's [Alert Center API](https://developers.google.com/workspace/admin/alertcenter/guides/authorizing) only works with a service account and domain-wide delegation, which this one-click integration does not use.
- **Very large tenants.** Licence and storage lookups hold at most 50,000 entries per sync. Above that, the section says the data is not shown instead of showing a partial list.

## Setup Instructions

The same steps are shown in Weavestream on the Google Workspace integration's **App** tab (and, for one connection, on its **Connections** tab). Steps 1–6 are done **once per Weavestream install**. Steps 7–9 are done **once per customer**.

The integration has these tabs:

- **App**: client ID, client secret (write-only, last four characters shown), redirect URI and scopes with copy buttons, the setup guide and **Check setup**.
- **Connections**: one row per customer tenant (domain and customer ID, who connected, when, last sync, status) with **Reconnect** and **Disconnect**. Press **Connect a client** to add a tenant. Click a row to run **Check setup** for that tenant.
- **Organizations**: every connected tenant, to map to a company.
- **Map layouts**, resource tabs, **Differences**, **Run history** and **Credentials & schedule** are shared by all connections.

Only one Google Workspace integration can exist; **New integration** refuses a second one.

### Step 1: Create a Google Cloud project

Open [console.cloud.google.com/projectcreate](https://console.cloud.google.com/projectcreate) and create a project. Any Google account works; your own company's Workspace admin account is a good choice. Name it, for example, **Weavestream**, and make sure it is selected at the top of the console.

### Step 2: Turn on two Google APIs

Open each API with the project selected and press **Enable**:

- [Admin SDK API](https://console.cloud.google.com/apis/library/admin.googleapis.com) (users, groups, domains, devices, usage reports)
- [Enterprise License Manager API](https://console.cloud.google.com/apis/library/licensing.googleapis.com) (licences)

### Step 3: Set up the consent screen and publish it

Open **Google Auth Platform** (press **Get started** if you see it).

1. **Branding**: app name **Weavestream**, your support email and a developer contact email.
2. **Audience**: user type **External**. Then press **Publish app** so the status shows **In production**.

Do not leave the app in **Testing**: in Testing, every connection stops working after 7 days. You do not need Google verification. An unverified app can be approved by up to **100 admins in total** over the life of the project; you connect one admin per customer, so that is plenty.

<!-- TODO(screenshot): ![Google Auth Platform Audience page set to External, In production](./assets/google-workspace-audience.png) -->

### Step 4: Add the scopes

Open **Data Access**, press **Add or remove scopes**, and paste the scope list from the Weavestream setup guide under **Manually add scopes**. Press **Add to table**, **Update**, then **Save**. The scopes are listed under [Security model](#security-model).

### Step 5: Create the OAuth client

Open **Clients** and press **Create client**:

- Application type: **Web application**
- Name: **Weavestream**
- **Authorized redirect URIs**: press **Add URI** and paste the redirect URI from the Weavestream setup guide (it ends in `/v1/admin/integrations/oauth/callback`).

Press **Create** and copy the **Client ID** and **Client secret**. Google shows the secret only once; you can also download it as JSON.

<!-- TODO(screenshot): ![Create OAuth client with the redirect URI filled in](./assets/google-workspace-client.png) -->

### Step 6: Paste the client into Weavestream

Go to **Admin > Integrations**. If there is no Google Workspace integration yet, press **New integration** and choose **Google Workspace** (once per install). Open it, go to the **App** tab, paste the Client ID and Client secret and press **Save OAuth app** (this asks you to confirm with MFA). Then press **Check setup**: steps that pass turn green, and a red step tells you what to fix. Check setup proves the client ID and secret only; the redirect URI step stays unconfirmed ("Redirect URI is confirmed on the first successful connect") until the first connect succeeds, after which a connection's Check setup shows it passed.

<!-- TODO(screenshot): ![Google Workspace integration, App tab with the client saved](./assets/google-workspace-app-tab.png) -->

### Step 7: Connect a customer

1. Open the **Google Workspace** integration and go to its **Connections** tab.
2. Press **Connect a client** (this asks you to confirm with MFA).
3. Sign in with that customer's **super admin**. A delegated admin also works if their role can read users, groups, reports, licences and devices.
4. On the "Google hasn't verified this app" screen, press **Advanced**, then **Go to Weavestream (unsafe)**. This warning appears because the app is your own and not reviewed by Google; the data only goes to your own Weavestream server.
5. Tick every permission and press **Continue**.

Back in Weavestream, the tenant appears as a new row. Click it and press **Check setup** in the setup guide to confirm each API answers. A tenant that is already connected cannot be added twice: use **Reconnect** on its row. Reconnect only accepts a sign-in to that same tenant; signing in to another tenant changes nothing and says so.

<!-- TODO(screenshot): ![Connections tab with two client tenants](./assets/google-workspace-connections.png) -->

### Step 8: If the customer blocks third-party apps

If sign-in fails with "access blocked" or `admin_policy_enforced`, the customer only allows approved apps. In the customer's Google Admin console, open **Security > Access and data control > API controls > Manage third-party app access**, press **Configure new app**, search for your **Client ID**, and set it to **Trusted**. Then connect again.

### Step 9: Map layouts and run the first sync

1. Open **Organizations**: every connected tenant is listed there. Map it to its Weavestream company.
2. Open **Map layouts** (see below), then set **Status** to active and save.
3. Run a **Dry run**, check **Run history**, then **Run sync now**.

## Map Layouts and Match-first

The **Map layouts** tab lists every Google resource. For each one, pick the layout it goes into (or create a new one, or skip it) and the field to match on. Weavestream suggests existing layouts by name, such as People for users and Phones for mobile devices. If the layout you pick has no field for the match value (for example no Email field on People), choose **Create field** in the match picker and Weavestream adds that field to the layout when you save; it is pre-selected when no existing field fits.

Below the match picker, a table lists the resource's standard facts (for users: Job title, Department, Phone). Each row is pre-set to an existing layout field whose name fits (for example **Title** or **Work phone**) and whose type can hold the value. When none fits, the row is set to **Create field**, which adds a field with that name on save (a phone field for Phone, an IP address field for IP address). Pick **Don't sync** to leave a fact out. A field with the same name but another type is never changed: pick another field instead. **Create new layout** and **Create field** also need permission to manage asset layouts.

On sync, a Google record whose match value equals **exactly one** unlinked asset you created yourself adopts that asset instead of creating a duplicate. Text matching ignores upper and lower case. If two or more assets match, the run reports it and links nothing, so you can clean up the duplicates first.

When none of your own assets match, a record also links to **exactly one** asset another integration already syncs (for example a Chromebook from an RMM). Google then fills that asset's fields according to the integration priority order, and a value that differs from a higher integration's is listed under **Differences** in the Google Workspace section. See [Several integrations on one asset](/integrations/#several-integrations-on-one-asset).

An adopted asset keeps the name you gave it. Assets that Google created follow the Google name (for example when a user is renamed).

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Check setup: step 5 or 6 red, "does not recognise this client ID and secret" | Wrong client ID or secret (`invalid_client`) | Copy both again from **Clients** and save. Create a new secret if you lost it. |
| Check setup: step 5 red, "redirect URI is not registered" | Redirect URI missing or different (`redirect_uri_mismatch`) | Add the exact redirect URI from the guide under **Authorized redirect URIs**. |
| Check setup: step 2 red, names an API | API not enabled (`accessNotConfigured` / `SERVICE_DISABLED`) | Enable that API in the same project, wait a few minutes, check again. |
| Check setup: step 7 red, "no admin access" | The connected account is not an admin or lacks a privilege (403) | Reconnect with a super admin, or give the delegated admin read access to that data. |
| Check setup: step 7 red, "tick every permission" | A permission box was left unticked on the consent screen | Press **Reconnect** and tick every permission. |
| Check setup: step 8 red, or sign-in says access blocked | The customer blocks unconfigured apps (`admin_policy_enforced`) | Mark the client ID **Trusted** in the customer's Admin console (step 8). |
| Check setup: step 3 red, or sign-in says the app is limited to its organisation | Audience is **Internal** (`org_internal`) | Set Audience to **External** and publish the app. |
| After Google sign-in you land on the login page, or Check setup says "API_URL and APP_URL must share a host" | `API_URL` is on a different host from `APP_URL`, so the browser does not send the session cookie to the callback | Serve the API under the web app's host (for example `APP_URL=https://ws.example.com`, `API_URL=https://ws.example.com/api`), update the redirect URI on the OAuth client, and connect again. |
| A connection shows **needs reconnect**: the saved connection can't be read | The stored connection was encrypted under a key that is no longer configured, or is damaged | Press **Disconnect** on its row (it removes the unreadable connection without calling Google), then **Connect a client**. If `INTEGRATION_SECRET_KEY` was rotated by mistake, restore the old key instead. |
| A connection shows **needs reconnect** after a sync | The refresh token was revoked, the admin was deleted or lost admin rights, or it went unused for 6 months (`invalid_grant`) | Press **Reconnect** and sign in with a current admin. |
| Connections stop working after a week | The app is still in **Testing** (tokens expire after 7 days) | Press **Publish app** under **Audience**, then reconnect each customer. |
| "Google hasn't verified this app" warning | Expected for a self-hosted app | Press **Advanced**, then **Go to Weavestream (unsafe)**. |
| Google refuses new connections with a user cap message | An unverified app allows 100 approving admins over the project's life | Submit the app for Google verification. Do not switch the App tab to a client from another Cloud project: every connection's refresh token belongs to the client that issued it, so all existing connections would stop working until reconnected. |
| Storage shows "not available" or an older date | Usage reports lag 1–3 days | Wait; the next sync picks up newer figures. |
| A layout field stopped updating from Google | Someone changed it in Weavestream, so it is listed as a difference | Open the asset (or the integration's **Differences** tab) and choose **Use Google Workspace value** or **Keep ours**. |
| Phone stays empty for a user | The number has letters (such as an extension) or too few digits to be an international number | Fix the number in Google, or type it in Weavestream. |
| A record was not linked and the run reports "multiple assets match" | Two or more of your assets share the match value | Remove or rename the duplicates, then sync again. |
| Run warning: "Skipped resource chrome_devices" or "mobile_devices" | The connected account cannot read devices (it lacks the device management admin privilege) | Reconnect with a super admin, or leave the resource disabled. Users and groups still sync. |

## Security Model

- **Read-only.** The driver only sends GET requests to Google. Check setup is read-only too.
- **Scopes requested**: `openid`, `userinfo.email`, and `admin.directory.user.readonly`, `admin.directory.group.readonly`, `admin.directory.group.member.readonly`, `admin.directory.domain.readonly`, `admin.directory.customer.readonly`, `admin.directory.device.chromeos.readonly`, `admin.directory.device.mobile.readonly`, `admin.reports.usage.readonly`, `apps.licensing` (each prefixed with `https://www.googleapis.com/auth/`). Google offers no read-only variant of `apps.licensing`; Weavestream only reads with it.
- **Encrypted secrets.** The OAuth client secret and each customer's refresh token are encrypted at rest (AES-256-GCM) and never shown again or logged. Saving the client, connecting and disconnecting need the integration management permission and an MFA step-up, and are audited. Each connection's refresh token is encrypted bound to that connection and its integration, so it cannot be moved onto another tenant's row.
- **State and PKCE.** Every connect uses a single-use random state bound to the signed-in user, the integration and the intent (a new connection, or Reconnect of one connection), plus a PKCE code verifier. The tenant is read from Google with the new grant before anything is stored.
- **Exact scopes only.** Weavestream never asks Google to add previously granted scopes to a connection. If Google returns a grant with a scope Weavestream did not request, the connect fails and is audited (`excess_scopes`); a grant missing some requested scopes still connects, and Check setup names what is missing. Connections of a Google integration can only be added by Connect a client and removed by Disconnect.
- **Callback URLs stay out of logs.** Weavestream logs request paths without their query string, so the authorization code and state of `/oauth/callback` never reach its logs. Configure your reverse proxy the same way (log the path, not the query string, for `/v1/admin/integrations/oauth/callback`), or keep proxy access logs short-lived and access-controlled.
- **Tenant isolation.** A sync of a company mapping only loads the connection whose customer ID equals the mapping's, so one tenant's token never reaches another tenant's mapping. The driver also re-checks the customer ID with Google and stops the sync on a mismatch.
- **No raw Google errors.** Errors shown in Weavestream are fixed messages; Google's own error text is never passed through.
- **Hidden from client users.** Google Workspace sections and differences are never shown to client users, even on assets they can see.
- **Audited choices.** Resolving a difference needs permission to edit that asset's company and writes an `integration.difference.resolve` audit row (ids and the choice, never the values). A bulk action on the **Differences** tab writes one such row per difference plus an `integration.difference.resolve_bulk` summary row (counts only); differences in companies you cannot edit are skipped and listed.
