---
label: Cloudflare Zero Trust IP Lists
icon: shield
order: 840
description: Use Weavestream to manage Cloudflare Zero Trust Access Control IP lists and keep access policies in sync.
---

# Cloudflare Zero Trust IP Lists

Weavestream can act as the source of truth for Cloudflare Zero Trust Gateway **IP lists** — the named lists that Access policies and Gateway rules reference to allow or block traffic by IP. Every change you make in Weavestream is pushed to Cloudflare immediately, and a background drift check automatically corrects any out-of-band edits made directly on the Cloudflare dashboard.

---

## Prerequisites

- A **Cloudflare account** with Zero Trust enabled.
- At least one **IP list** created in Cloudflare Zero Trust → Reusable Components → Lists (kind: IP).
- A **Cloudflare API token** with the `Zero Trust: Edit` permission (details below).
- Weavestream **1.6.4 or later**.

---

## Step 1 — Create the Cloudflare IP list

If you do not already have an IP list to manage, create one in Cloudflare first:

1. In the Cloudflare dashboard, go to **Zero Trust → Reusable Components → Lists**.
2. Click **Create a list**, choose **IP Addresses** as the type, give it a name (e.g. `weavestream-allowed`), and save.

You can leave the list empty — Weavestream will populate it after the integration is set up.

> **Note:** This integration manages **Zero Trust Access Control Lists**, not the WAF Rules Lists found under Account → Configurations → Lists. Make sure you are in the Zero Trust section.

---

## Step 2 — Create a Cloudflare Application Policy (optional but recommended)

To use the IP list to restrict access to an application:

1. Go to **Zero Trust → Access Controls → Applications** and select (or create) your application.
2. In the application's **Policies**, create a new Allow policy.
3. Add an **Include** rule with type **IP ranges** and select the list you created in Step 1.
4. Save the policy.

Cloudflare will automatically pick up changes to the list — no policy update is needed when you add or remove IPs through Weavestream.

---

## Step 3 — Create a Cloudflare API Token

1. In the Cloudflare dashboard, go to **Profile → API Tokens → Create Token**.
2. Use the **Create Custom Token** option.
3. Under **Permissions**, add:
   - **Account → Zero Trust → Edit**
4. Under **Account Resources**, scope it to your account.
5. Click **Continue to summary**, then **Create Token**.
6. Copy the token — it is shown only once.

---

## Step 4 — Add the integration in Weavestream

1. Navigate to **Admin → Integrations → New Integration**.
2. Select **Cloudflare Zero Trust Lists** as the provider.
3. Fill in the required fields:

   | Field | Where to find it |
   |---|---|
   | **Cloudflare Account ID** | Cloudflare dashboard → select your account → the ID is shown in the right-hand sidebar on the overview page |
   | **API Token** | The token you created in Step 3 |

4. Click **Test Connection** — Weavestream will connect to your account and report how many Gateway lists it can see.
5. Click **Save**.

---

## Step 5 — Register an IP list

Connecting the integration gives Weavestream access to your Cloudflare account. You still need to tell it which IP list to manage:

1. Open the integration you just created.
2. Click **Link Cloudflare List**.
3. Weavestream fetches all IP lists in your account and displays them. Lists already registered are marked.
4. Select the list you want to manage and click **Register**.

Weavestream imports the current entries from Cloudflare as the starting state. From this point Weavestream is the source of truth for that list.

You can register multiple lists to a single integration.

---

## Managing entries

Once a list is registered, use the list detail page to manage its IP entries:

| Action | How |
|---|---|
| **Add an IP** | Click **Add Entry**, enter a valid IPv4, IPv6, or CIDR value and an optional description, then save. The IP is pushed to Cloudflare immediately. |
| **Edit an IP** | Click the pencil icon on any entry. Changing the IP value replaces it on Cloudflare; only the description changes locally. |
| **Remove an IP** | Click the trash icon. The IP is removed from Cloudflare immediately. |

All mutations are recorded in the Weavestream audit log.

---

## Drift detection and self-healing

Weavestream runs a periodic drift check against every registered list. If it finds that Cloudflare's copy of the list no longer matches what Weavestream has stored — for example, because someone edited the list directly on the Cloudflare dashboard — it automatically re-pushes the correct entries to restore sync.

- The list status shows **In sync** or **Drift detected** at a glance.
- Click **Check drift now** on a list to run an immediate check instead of waiting for the next scheduled sweep.
- If the automatic push fails (e.g. a temporary API error), the status stays at **Drift detected** and the error detail is shown. The sweep will retry on the next run.

> Weavestream is the source of truth. Any change made directly in Cloudflare that contradicts the Weavestream list will be silently reverted on the next drift sweep.

---

## Removing the integration

Unregistering a list in Weavestream removes Weavestream's local copy only — the Cloudflare list and its entries are **not** deleted. Deleting the integration itself removes all registered list records from Weavestream; again, no Cloudflare data is removed.
