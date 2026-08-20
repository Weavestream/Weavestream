---
label: Invite Users
icon: person-add
order: 700
description: Add operators, contractors, and client users to your Weavestream instance.
---

# Invite Users

Weavestream uses an invite-only registration model. There is no self-registration page. A `SUPER_ADMIN` creates user accounts and distributes one-time setup links.

## Step 1 — Create a user account

Navigate to **Admin → Users** and click **New User**.

Fill in:

| Field | Description |
|---|---|
| Email | The user's email address (used for login) |
| Global role | `SUPER_ADMIN`, `OPERATOR`, `CONTRACTOR`, or `CLIENT_USER` |

A **Setup Token** is generated automatically. This is a one-time URL the user will use to complete their registration.

## Step 2 — Share the setup link

Copy the setup URL and send it to the user (via email, Slack, etc.). The link looks like:

```
https://your-instance.com/setup/<token>
```

The token is time-limited and single-use. If it expires before the user completes setup, you can regenerate it from the user's account page.

## Step 3 — User completes setup

The user:

1. Opens the setup URL
2. Sets their display name and a password
3. Scans the TOTP QR code with their authenticator app
4. Enters a code to confirm enrollment

After setup is complete, the user can log in immediately.

## Step 4 — Grant tenant access (Operators and Contractors)

For `OPERATOR` and `CONTRACTOR` users, you also need to grant them access to specific tenants via **Memberships**.

Navigate to **Admin → Memberships** (or the tenant's **Members** page) and assign:

| Role | Access level |
|---|---|
| `OPERATOR_FULL` | Full read and write within the tenant |
| `OPERATOR_READONLY` | Read-only within the tenant |

For **Contractors**, set an `expiresAt` date. Access is automatically revoked after this date without any manual action required.

## Adding Client Users

For `CLIENT_USER` accounts, the flow is the same — create the account, share the setup link — but you assign client-specific membership roles:

| Role | Access |
|---|---|
| `CLIENT_ADMIN` | Client portal admin |
| `CLIENT_VIEWER` | Read-only client portal access |

Client users can only access the client portal (`/portal/<company-slug>`) for the tenants they are members of. They cannot navigate to the admin interface.

## Managing Existing Users

From **Admin → Users** you can:

- View all user accounts and their global roles
- Regenerate setup tokens for users who haven't completed setup
- Deactivate accounts (soft-delete — login is blocked, historical data is preserved)
- View the last login timestamp for each user

## Managing Memberships

From **Admin → Memberships** you can:

- View all active memberships across all tenants
- Add or remove memberships for any user
- Set or update contractor expiry dates

You can also manage memberships from an individual tenant's **Members** page, which shows only that tenant's members.
