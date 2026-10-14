---
label: Microsoft 365
icon: plug
description: Connect Microsoft 365 tenants by admin consent to sync people, Intune devices and groups into your layouts, with licences, storage, sign-in, MFA and tenant security on the asset page, and the tenant's domains into Domains monitoring.
---

# Microsoft 365 Integration

**Microsoft 365** is Microsoft's suite of business email, storage and collaboration apps, with identities in **Microsoft Entra ID** and devices in **Microsoft Intune**.

The Weavestream Microsoft 365 driver is **read-only** (with one exception an admin must opt into, see [Report names](#report-names-the-one-change-weavestream-can-make)). A Weavestream install has **one** Microsoft 365 integration. Its **App** tab holds the one multi-tenant app you register in your own Entra tenant, and its **Connections** tab holds one connection per customer tenant, each made with a single admin-consent approval by one of their Global Administrators.

## Overview & Features

- **Admin consent per customer**: a customer admin approves the app once. Weavestream then reads with the app's own identity (application permissions). No user signs in for syncs, and no password, user token or refresh token is stored.
- **Match first**: on the first sync, Microsoft records link to the assets you already have (users by email, devices by serial number). An asset is only created when nothing matches.
- **Standard facts fill your layout fields**: job title, department and phone for people; hostname, manufacturer, model, operating system and MAC address for computers; and a few more per resource (see below). Everything else shows in a **Microsoft 365** section on the asset page.
- **Your edits win**: a field someone changed in Weavestream is never overwritten. It is listed as a **difference** instead, and you choose which value to keep.
- **Usage bars**: mailbox and OneDrive storage per user, licences purchased vs assigned per product, Secure Score and MFA coverage for the tenant.
- **Built-in setup guide and Check setup**: the steps below are also shown inside Weavestream, and **Check setup** points to the step that needs fixing, including which permissions a tenant has not granted.

## Synced Data Reference

| Resource | Suggested layout | Matched on | Layout fields filled (when mapped) | Microsoft 365 section on the asset page |
|---|---|---|---|---|
| **Tenant** | Microsoft 365 Tenants (created) | Tenant ID | Name, Tenant ID, Primary domain | Overview (members, disabled members, guests, created), Licences assigned vs purchased (one bar per product), Subscriptions (status, licences, next lifecycle date, trial), Security (Secure Score, MFA coverage, users with admin roles, Global Administrators), Storage (OneDrive and SharePoint totals, data as of), Recent security alerts (last 30 days: severity, title, status, link) |
| **Users** | People | Email (the mail address, else the user principal name) | Name, Email, Job title, Department, Phone | Account (enabled, created, last sign-in, synced from on-premises, shared mailbox), Licences, Mailbox (storage bar against the quota, archive mailbox), OneDrive (storage bar), Security (MFA registered, admin roles, wasted licence) |
| **Groups** | Distribution Lists | Email | Name, Email, Description | Group (type: Microsoft 365, distribution or mail-enabled security; member count; members) |
| **Computers** (Intune: Windows, macOS, Linux) | Workstations or Laptops | Serial number | Name, Serial number, Hostname, Manufacturer, Model, Operating system, MAC address (Wi-Fi) | Intune (compliance, last check-in, enrolled, primary user, storage bar, management agent, encrypted, ownership) |
| **Mobile devices** (Intune: iOS, iPadOS, Android) | Phones | Serial number | Name, Serial number, Model, Manufacturer, Operating system, IMEI, Phone number | Intune (compliance, last check-in, primary user, ownership) |

Guests are not synced as people: they belong to other organisations. Only mail-enabled groups are synced (they are what a distribution list layout holds). Subscriptions appear only in the tenant section, never as separate assets.

**Wasted licence** is shown for a licensed user who is disabled, is a shared mailbox, or (only when the tenant has Entra ID P1, so sign-in data exists) has not signed in for 90 days. Friendly product names come from a list bundled with Weavestream; a product it does not know shows its part number (for example `CONTOSO_CUSTOM_SKU`).

### Licence-dependent data

Some data needs a licence the customer may not have. The record still syncs; the row says what is missing:

| Data | Needs | Without it |
|---|---|---|
| Last sign-in, MFA registered, MFA coverage | Microsoft Entra ID P1 (included in Microsoft 365 Business Premium, E3, E5) | "Not available (needs Entra ID P1)"; the wasted-licence rule then ignores sign-ins |
| Computers and Mobile devices | Microsoft Intune and `DeviceManagementManagedDevices.Read.All` | Both resources are skipped with a run warning: "Intune is not licensed in this tenant" when the permission is granted, otherwise which permission is missing. The run still succeeds, users, groups and the tenant sync, and devices already linked are left untouched. The integration is not paused. |
| Recent security alerts | A Microsoft Defender or other security licence | "Not available (needs Microsoft Defender ...)" |
| Mailbox and OneDrive storage per user | Real names in usage reports (see below) | "Hidden by the tenant's report privacy setting" |

### Domains feed Domains monitoring

On every sync of a mapped tenant, its **verified** custom domains go to the company's built-in **Domains** monitoring (WHOIS, DNS and TLS checks), exactly like Google Workspace domains. Each shows the Microsoft icon in the Domains list (after Cloudflare and Google) and a **Microsoft 365** card on its page: default domain or verified domain, verification, managed or federated sign-in, supported services (Email, Teams, Intune, ...), last sync and the integration.

- **Matched, never duplicated.** A Microsoft domain is matched to a domain the company already monitors by name (ignoring upper and lower case and a trailing dot), whether it was added by hand or synced from Cloudflare or Google. A match only gains the Microsoft details. Cloudflare wins on anything both provide.
- **New domains** are added to the mapped company with the default checks and get their first check right away.
- **Archived domains are left alone**, and no second copy is added beside them.
- **Skipped**: the initial `*.onmicrosoft.com` domain (and any other `onmicrosoft.com` name) and unverified domains.
- **A domain removed from the tenant** is never deleted: its Microsoft details are cleared and the card and list show **not in Microsoft 365 since** the date it disappeared.
- **Only the mapped company**, on real runs only (not on a dry run). A failure is a warning on the run and never fails it.
- The integration's name on the card is never shown to client users; the rest follows the domain's client visibility, like the Google card.

### How Microsoft updates your fields

The same rules as the other integrations: the first sync of a record writes every mapped field; later syncs fill empty fields and follow Microsoft while a field still holds the value Microsoft wrote last; a field someone changed is listed under **Differences** (on the asset and on the integration's **Differences** tab) with **Use Microsoft 365 value** and **Keep ours**. A value Microsoft does not report is never cleared.

**Match-first also links to assets other integrations created.** A user whose email (or a device whose serial number) equals **exactly one** asset another integration already syncs, such as the same person from Google Workspace or a laptop from Level RMM, joins that asset instead of creating a second one. The integration priority order (**Admin > Settings > Integrations**) decides whose values fill each field; when Microsoft is lower and its value differs, the difference is listed in the Microsoft 365 section. See [Several integrations on one asset](/integrations/#several-integrations-on-one-asset).

### What Microsoft cannot provide

- **No invoices or bill amounts.** Subscriptions show status, licence counts and the next lifecycle date (renewal or expiry), not prices.
- **No members of dynamic distribution groups.** They are Exchange objects that Microsoft Graph does not list.
- **No same-day storage.** Usage reports lag 24 to 72 hours; the section shows the date the figures are from.
- **No real names in reports while concealment is on** (see below).
- **Ethernet MAC addresses** are not in the Intune device list; only the Wi-Fi MAC is filled.

## Report names: the one change Weavestream can make

Microsoft hides user, group and site names in its usage reports by default, so mailbox and OneDrive storage cannot be matched to people. The setting is:

**Microsoft 365 admin center > Settings > Org settings > Services > Reports > "Conceal user, group, and site names in all reports"** (Microsoft Graph: `adminReportSettings.displayConcealedNames`).

After connecting, click the tenant's row on the integration's **Connections** tab. Weavestream reads the current value from that tenant and asks: **Show real names in Microsoft usage reports so storage can be matched to users?**

- **Yes, show real names (turn the setting off)**: after a confirmation that names the setting, Weavestream sends one `PATCH https://graph.microsoft.com/v1.0/admin/reportSettings` with `displayConcealedNames: false`. The change is **tenant-wide**: every Microsoft 365 usage report of that tenant (admin center, Microsoft Graph, Power BI, Teams admin center) then shows real user names, group names and site URLs. Anyone in the tenant who can read usage reports (for example Global, Exchange, SharePoint or Teams administrators and Reports Readers) sees them, and so does Weavestream. Microsoft records the change in the tenant's audit log.
- **No, keep names hidden (change nothing)**: nothing is sent to the tenant. Storage rows say they are hidden by the tenant's report privacy setting, and Check setup notes it.
- **Turn concealment back on**: shown while names are visible. It sends `displayConcealedNames: true`, after a confirmation. The same checkbox in the admin center works too.

**Optional permissions.** Reading the value needs `ReportSettings.Read.All` (or `ReportSettings.ReadWrite.All`); changing it needs `ReportSettings.ReadWrite.All`. Both are optional. When the tenant did not grant `ReportSettings.ReadWrite.All`, the page still shows the current value (when it can be read) and, instead of the buttons, the steps to change it by hand: sign in to the Microsoft 365 admin center as a Global Administrator, go to **Settings > Org settings**, on the **Services** tab select **Reports**, clear (show names) or select (hide names) **Conceal user, group, and site names in all reports**, and select **Save**. Weavestream never attempts the change without the permission.

The choice is per connection (client tenant). Each choice needs an MFA step-up, is stored with that connection, and writes an `integration.microsoft.report_names` audit row with the setting name, the value before and after, and whether anything changed (`.failed` with a reason when Microsoft refused). If the value cannot be read, nothing is changed. This PATCH is the only write the integration ever makes, and it is never made during a sync.

## Setup Instructions

The same steps are shown in Weavestream on the Microsoft 365 integration's **App** tab, with copy buttons. Steps 1–4 are done once per install; step 5 onward once per customer.

The integration has these tabs:

- **App**: client ID, client secret (write-only), secret expiry, directory (tenant) ID, redirect URI and permissions with copy buttons, the setup guide and **Check setup**.
- **Connections**: one row per customer tenant (name and tenant ID, granted permissions, connected at, last sync, status: ok, needs reconnect or app secret expired) with **Reconnect** and **Disconnect**. Press **Connect a client** to add a tenant. Click a row for its **Check setup** and the report-names choice.
- **Organizations**: every connected tenant, to map to a company.
- **Map layouts**, resource tabs, **Differences**, **Run history** and **Credentials & schedule** are shared by all connections.

Only one Microsoft 365 integration can exist; **New integration** refuses a second one.

### Step 1: Register one multi-tenant app in Entra

Once per Weavestream install, in your own tenant: open the **Microsoft Entra admin center** > **Entra ID > App registrations > New registration**.

- Name: **Weavestream**
- Supported account types: **Accounts in any organizational directory (Any Microsoft Entra ID tenant - Multitenant)**
- Redirect URI: platform **Web**, the redirect URI shown in Weavestream (it ends in `/v1/admin/integrations/oauth/callback`)

Press **Register** and keep the **Application (client) ID** and **Directory (tenant) ID** from the overview page.

### Step 2: Add the Microsoft Graph application permissions

Open **API permissions > Add a permission > Microsoft Graph > Application permissions** and add exactly these (Weavestream has a copy button for each). You can remove the default delegated `User.Read`. A connection that grants more than this list is refused.

| Permission | Why Weavestream needs it |
|---|---|
| `User.Read.All` | Users: names, email, job title, department, phones, enabled, licences, on-premises sync |
| `GroupMember.Read.All` | Groups and their members |
| `Organization.Read.All` | The tenant (name, domains) and its subscriptions |
| `LicenseAssignment.Read.All` | Licences purchased vs assigned per product |
| `Domain.Read.All` | Domains for Domains monitoring |
| `RoleManagement.Read.Directory` | Admin roles per user, admin counts |
| `MailboxSettings.Read` | Shared mailbox detection (`userPurpose`) |
| `AuditLog.Read.All` | Last sign-in and MFA registration (needs Entra ID P1) |
| `Reports.Read.All` | Mailbox, OneDrive and SharePoint usage reports |
| `SecurityEvents.Read.All` | Secure Score |
| `SecurityAlert.Read.All` | Recent security alerts |
| `DeviceManagementManagedDevices.Read.All` | Intune computers and mobile devices |
| `ReportSettings.Read.All` (optional) | Read the report concealment setting, so the integration page can show it |
| `ReportSettings.ReadWrite.All` (optional) | Only if you want Weavestream to be able to turn report name concealment off/on for a customer (see above). Without it the page shows the manual admin center steps instead of the buttons |

### Step 3: Create a client secret and note its expiry

**Certificates & secrets > Client secrets > New client secret**, pick an expiry (at most 24 months), press **Add**, and copy the secret **Value** (not the Secret ID): Entra shows it only once. Note the **Expires** date. To rotate, create a second secret before the first expires, save it in Weavestream, then delete the old one.

### Step 4: Paste the app into Weavestream

Go to **Admin > Integrations**. If there is no Microsoft 365 integration yet, press **New integration** and choose **Microsoft 365** (once per install). Open it, and on the **App** tab paste the **Application (client) ID**, the secret value, the secret expiry date and, optionally, your **Directory (tenant) ID**, then press **Save Microsoft app** and **Check setup**. With the tenant ID, Check setup proves the client and secret by requesting a token in your own tenant; without it, it can still catch a wrong secret, an unknown app or a single-tenant app.

From 30 days before the expiry date, the App and Connections tabs show a warning; after it, every connection shows **app secret expired**.

<!-- TODO(screenshot): ![Microsoft 365 integration, App tab with the app saved](./assets/microsoft-365-app-tab.png) -->

### Step 5: Connect a customer (admin consent)

Open the **Microsoft 365** integration, go to its **Connections** tab and press **Connect a client** (this asks you to confirm with MFA). Sign in as the customer's **Global Administrator** or **Privileged Role Administrator** and press **Accept**. A Cloud Application Administrator or Application Administrator cannot grant Microsoft Graph application permissions. The app shows as **unverified**; that is expected and does not stop an admin from approving.

Weavestream never trusts the tenant Microsoft names in the return link: it requests a token for that tenant and checks the token's tenant, the app, and the tenant reported by Microsoft Graph, then adds the tenant as a new row. If some permissions were not granted, the connection is saved and its **Check setup** lists them. A tenant that is already connected cannot be added twice: use **Reconnect** on its row. Reconnect only accepts consent from that same tenant; consent from another tenant changes nothing and says so.

<!-- TODO(screenshot): ![Connections tab with two customer tenants](./assets/microsoft-365-connections.png) -->

### Step 6: Choose whether usage reports show real names

See [Report names](#report-names-the-one-change-weavestream-can-make).

### Step 7: Map the company and layouts, then sync

Open **Organizations** and map the tenant to its Weavestream company, set **Status** to active, then on **Map layouts** pick a layout and match field per resource (for example Users to People, matched on Email). Run a **Dry run**, then **Run sync now**.

## Troubleshooting

Check setup reads only the AADSTS number and the Graph error code Microsoft returns ([Entra error codes](https://learn.microsoft.com/en-us/entra/identity-platform/reference-error-codes)); Microsoft's own error text is never shown.

| Symptom | Cause | Fix |
|---|---|---|
| Check setup: step 3 red, AADSTS7000215 | Invalid client secret (often the Secret ID was pasted instead of the Value) | Copy the secret **Value** again and save. |
| Check setup: step 3 red, AADSTS7000222, or the expiry warning | The client secret expired | Create a new secret, save it with its new expiry date. |
| Check setup: step 4 red, AADSTS700016 | Wrong Application (client) ID, or the tenant ID is not where the app is registered | Copy both IDs again from the app overview. |
| Check setup: step 1 red, AADSTS50194 | The app is single-tenant | Set **Supported account types** to **Accounts in any organizational directory**. |
| Check setup: step 4 red, AADSTS90002 | The Directory (tenant) ID is wrong | Copy it again from the app overview. |
| Check setup: note "Save your Directory (tenant) ID" | No tenant ID saved, so the secret could not be fully verified | Add your Directory (tenant) ID on the Microsoft app card. |
| Connect fails: "A Global Administrator or Privileged Role Administrator ... must approve" | The approver is not allowed to grant application permissions (for example AADSTS90094) | Have a Global Administrator or Privileged Role Administrator connect. |
| Connect fails: "Microsoft did not grant consent" | The admin cancelled the consent page (for example AADSTS65004) | Connect again and press **Accept**. |
| Connect fails: "more permissions than Weavestream uses" | Extra permissions were added to the app registration | Remove them from **API permissions**, then connect again. |
| Connect fails: "could not verify the tenant" | The tenant in the return link did not match the token or Microsoft Graph | Connect again; nothing was saved. |
| Check setup: step 2 red, "Not granted in this tenant: ..." | The tenant approved an older permission list | Add any missing permission to the app (step 2), then press **Reconnect** as a Global Administrator. |
| Sync paused: "the customer tenant no longer has this app" (AADSTS700016, AADSTS65001) | The customer deleted the Weavestream enterprise application or removed consent | Press **Reconnect** and approve again. |
| Sync paused: "The app is disabled in the customer tenant" (AADSTS7000112) | The enterprise application was disabled | Enable it in the customer tenant, or **Reconnect**. |
| Rows say "Not available (needs Entra ID P1)" | No Entra ID P1 licence | Expected; the rest syncs. |
| Computers and Mobile devices sync nothing, run warning about Intune | No Intune licence, or `DeviceManagementManagedDevices.Read.All` not granted | Expected without Intune; otherwise reconnect. |
| Storage says "Hidden by the tenant's report privacy setting" | Names are concealed in usage reports | Choose **Show real names** on the integration, or leave it. |
| Storage shows "not available" or an older date | Usage reports lag 24 to 72 hours | Wait; the next sync picks up newer figures. |
| "Microsoft refused the change: ReportSettings.ReadWrite.All is not granted" | The tenant approved an older permission list | **Reconnect** as a Global Administrator, then choose again. |
| The integration page lists admin center steps instead of buttons | The optional `ReportSettings.ReadWrite.All` is not granted in this tenant | Follow the steps, or add the permission to the app and **Reconnect**. |
| Run rate limited | Microsoft Graph throttling (429); usage reports allow about 14 requests per 10 minutes per tenant | Weavestream waits for the time Microsoft asks and retries; each report is fetched once per run. |
| After Microsoft sign-in you land on the login page | `API_URL` is on a different host from `APP_URL` | Serve the API under the web app's host and update the redirect URI on the app registration. |
| The redirect URI starts with `http://`, or Check setup says "API_URL must start with https://" | `API_URL` uses `http://` on a host that is not `localhost`, and Microsoft rejects that redirect URI | Set `API_URL` (and `APP_URL`) to the `https://` origin, run `docker compose up -d`, and update the redirect URI on the app registration. |

## Security Model

- **App-only, no user tokens.** Weavestream holds one client secret (yours) and, per customer, only the verified tenant ID, the granted permissions, the consent time and the report-names choice. Access tokens are minted per tenant with the client credentials grant, cached in memory per connection until shortly before they expire, and dropped on a reconnect or a new client secret. There is no refresh token.
- **Encrypted secret with an expiry warning.** The client secret is encrypted at rest (AES-256-GCM), write-only (only its last four characters are shown), saved with an MFA step-up and audited. Weavestream warns 30 days before the expiry date you enter.
- **Verified tenant.** The consent callback's `tenant` value is never trusted: the token's tenant (`tid`) and Microsoft Graph's own answer must both match it, and the token's app must be yours. The state is random, single use, valid for ten minutes and bound to the signed-in user, the integration and the intent (a new connection, or Reconnect of one connection). Error callbacks are mapped to fixed messages; Microsoft's description is never stored, logged or shown.
- **Least privilege.** Every permission is read-only except the optional `ReportSettings.ReadWrite.All`, which is never needed for a sync and is used for one PATCH of `displayConcealedNames`, only from the explicit, step-up gated, audited admin action, never during a sync. A connection with more permissions than the list is refused. Report usage downloads are only followed to Microsoft hosts.
- **Read-only sync.** The sync and Check setup only send GET requests to Microsoft Graph (plus `$batch` requests whose sub-requests are fixed to GET). Report downloads follow Microsoft's redirect through the egress guard without the access token.
- **Tenant isolation.** A sync of a company mapping only loads the connection whose tenant ID equals the mapping's, so one tenant's consent never reaches another tenant's mapping. Each connection's consent is encrypted bound to that connection and its integration. A mapped tenant that differs from the consented one, or from what Microsoft Graph reports, still stops the sync.
- **Customer control.** The customer can remove access at any time by deleting the Weavestream enterprise application in their tenant; Weavestream then shows **Reconnect**. Conditional Access policies for users do not apply to this app-only identity.
- **Hidden from client users.** Microsoft 365 sections and differences are never shown to client users.
