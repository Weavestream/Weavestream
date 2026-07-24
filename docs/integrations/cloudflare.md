---
label: Cloudflare Zero Trust
icon: plug
description: Manage Cloudflare Zero Trust Gateway IP lists directly from Weavestream with automatic drift detection.
---

# Cloudflare Zero Trust Lists Integration

**Cloudflare Zero Trust Lists** lets you manage Cloudflare Zero Trust Gateway IP lists directly from Weavestream. 

Instead of manually editing IP lists across individual Cloudflare tenant dashboards, you add, update, and remove IP and CIDR entries inside Weavestream. Changes are pushed to Cloudflare immediately, establishing Weavestream as the primary source of truth.

## Key Capabilities

- **Bidirectional Sync & Push**: Manage Cloudflare Zero Trust Gateway IP lists natively within Weavestream.
- **Automated Drift Detection**: A background drift sweep constantly compares Cloudflare state against Weavestream records, detecting and auto-correcting out-of-band edits.
- **IPv4 and IPv6 Support**: Full validation and support for single IP addresses and CIDR prefix blocks (e.g. `192.168.1.0/24` and `2601:280:5280:7bc0::/64`).
- **Multi-List Registration**: Register multiple Cloudflare Gateway IP lists under a single API integration instance.

## Managed Attributes Reference

| Attribute | Description | Support / Format |
|---|---|---|
| **IP Address / CIDR** | Network address prefix or single host | IPv4 (`192.168.1.1`), IPv4 CIDR (`10.0.0.0/16`), IPv6 (`2001:db8::1`), IPv6 CIDR (`2601:280:5280::/64`) |
| **Description** | Optional human-readable description label | String label stored alongside the list entry |
| **Drift Status** | Live status relative to Cloudflare | `In sync`, `Drift detected`, or `Error` |
| **Last Pushed** | UTC timestamp of last successful API push | Date / Timestamp |

## Setup Instructions

### Prerequisites
- A Cloudflare account with Zero Trust enabled.
- Cloudflare **Account ID**.
- A Cloudflare **API Token** with the **Account → Zero Trust → Edit** permission.

### Step 1: Create the Cloudflare API Token
1. Log into your **Cloudflare Dashboard**.
2. Navigate to **My Profile → API Tokens → Create Token**.
3. Select **Create Custom Token**.
4. Set permissions to: **Account → Zero Trust → Edit**.
5. Set **Account Resources** to your target account.
6. Click **Continue to Summary** and **Create Token**. Copy the generated token.

### Step 2: Configure Integration in Weavestream
1. In Weavestream, navigate to **Admin → Integrations → New Integration**.
2. Select **Cloudflare Zero Trust Lists** as the provider.
3. Enter your **Cloudflare Account ID** and the **API Token**.
4. Click **Test Connection** to verify access to your Cloudflare Zero Trust environment.
5. Click **Save**.

### Step 3: Link an Existing Gateway List
1. Open the created Cloudflare integration detail page.
2. Click **Link Cloudflare List**.
3. Select the Gateway list you wish to manage from the list of discovered Cloudflare Zero Trust Gateway lists.
4. Click **Register List**. Weavestream will import existing entries and begin active management.

> [!NOTE]
> For detailed step-by-step instructions—including setting up Cloudflare Gateway policies and firewall rules—see the complete [Cloudflare Zero Trust IP Lists guide](/guides/cloudflare-zero-trust-ip-lists/).
