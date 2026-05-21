---
label: First Login
icon: key
order: 800
description: Complete MFA enrollment and configure your workspace after first boot.
---

# First Login

After creating the admin account via `create-admin`, follow these steps to complete your initial setup.

## 1. Open the login page

Navigate to [http://localhost:3000/login](http://localhost:3000/login) (or your configured `APP_URL`).

Enter the email and password you set with `create-admin`.

## 2. Enroll your authenticator app

Weavestream requires TOTP MFA on **every account**. On first login, you will be redirected to the MFA enrollment screen.

1. Open an authenticator app (Google Authenticator, Authy, 1Password, Bitwarden, etc.)
2. Scan the QR code displayed on screen, or manually enter the secret key
3. Enter the 6-digit code to confirm enrollment

!!!info No skip option
There is no way to bypass MFA enrollment. Every account — including SUPER_ADMIN — must complete this step.
!!!

## 3. Configure your workspace

Sign in and navigate to **Admin → Settings**.

### Workspace name

Set the name that appears in the top-left sidebar chip. This is your organisation or product name (e.g. "Acme IT", "Helpdesk", "My MSP").

### Tenant terminology

Choose the word used everywhere in the UI for "tenant":

| Preset | Best for |
|---|---|
| Company (default) | General use |
| Client | MSPs managing external customers |
| Department | Internal IT teams |
| Tenant | Multi-tenanted environments |
| Site | Physical location tracking |
| Organisation | Larger entities |
| Custom | Enter any term |

The live preview on the settings page shows how the sidebar, dialog titles, and empty states will look with your chosen term.

## 4. Create your first company

Navigate to **Admin → Companies** (or whatever your tenant term is) and click **New [Company]**.

Fill in the name and any relevant contact details. This creates your first tenant, which you can then populate with articles, assets, and passwords.

## 5. Set up your profile

Click your avatar in the bottom-left corner to access **My Account**. Here you can set:

- Display name
- Timezone (for date/time display throughout the app)
- Theme (Dark, Light, or System)
- Accent colour

## What's next?

- [Invite Users](/getting-started/invite-users/) — add team members
- [Asset Layouts guide](/guides/asset-layouts/) — define your infrastructure templates
- [Writing Articles guide](/guides/writing-articles/) — start documenting
