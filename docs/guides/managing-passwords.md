---
label: Managing Passwords
icon: lock
order: 880
description: Set up and use the password vault for secure credential storage.
---

# Managing Passwords

This guide covers the day-to-day workflow for the Weavestream password vault — adding credentials, organising them, and retrieving them safely.

## Adding a Password

1. Navigate to a tenant's **Passwords** section
2. Click **New Password**
3. Fill in the details:
   - **Name** — a descriptive label (e.g. "Production Database", "AWS Root Account")
   - **Username** — the login name
   - **URL** — the service URL (optional)
   - **Password** — the secret (see [Using the Generator](#using-the-generator))
   - **TOTP Secret** — the authenticator secret if the account uses 2FA
   - **Notes** — any additional context (supports rich text)
   - **Expiry date** — when this credential should next be rotated
   - **Tags** — colour-coded labels for organisation
4. Click **Save**

## Using the Generator

Click the generator icon next to the password field to open the offline password generator.

| Mode | Description |
|---|---|
| **Words + symbols** | Memorable word-based password with optional symbols |
| **Passphrase** | Several random words separated by a character |
| **Custom length** | Character-class-based random string |

The generated password is inserted directly into the password field. Nothing is sent to a server.

## Reading the Strength Meter

The strength meter (powered by zxcvbn) evaluates the password in real time:

| Score | Meaning |
|---|---|
| Very Weak | Easily guessable — common word, keyboard pattern |
| Weak | Short or predictable |
| Fair | Moderate — could be improved |
| Strong | Good entropy |
| Very Strong | Excellent — use this |

Hover over the meter to see specific warnings and suggestions.

## Breach Detection

After saving, the worker checks the password against HaveIBeenPwned using a k-anonymity prefix lookup. If the password appears in a known breach, a warning banner is shown on the credential's detail page.

No full passwords leave your server — only the first 5 characters of the SHA-1 hash are sent to the HIBP API.

## Revealing a Password

1. Open the credential's detail page
2. Click **Reveal** next to the password field
3. If **Reason to view** is enabled on the credential, enter the required justification
4. The plaintext password is displayed for 30 seconds, then re-masked

Every reveal is logged to the audit trail with your username, IP address, and timestamp.

## Copying Credentials

Click the **Copy** icon next to any field (password, username, TOTP code) to copy it to the clipboard without displaying the value on screen.

## Organising with Folders

Create a folder hierarchy to group related credentials:

1. Click **New Folder** in the password list sidebar
2. Name the folder (e.g. "Infrastructure", "SaaS Tools", "Client Accounts")
3. Drag passwords into folders, or assign a folder when creating/editing a password

Folders can be nested to any depth.

### Renaming and Archiving Folders

Click the **gear icon** next to a folder name in the sidebar to open the folder settings dialog:

- **Rename** — type a new name and save to update the folder label across the vault
- **Archive** — archives the folder and all credentials inside it. Archived content is hidden from the default view but is not deleted. Toggle **Show archived** at the top of the passwords browser to restore visibility

Archived folders can be unarchived at any time from the same settings dialog.

## Version History

Every change to a credential creates a new version. To view the history:

1. Open the credential's detail page
2. Click the **History** tab
3. Each version shows what changed, who changed it, and when

Versions are immutable and cannot be deleted.

## Archiving Credentials

To remove a credential from the active list without deleting it:

1. Open the credential
2. Click **⋯ → Archive**

Archived credentials retain their full history and can be restored at any time.

## Access Restrictions

For sensitive credentials, you can add restrictions:

| Restriction | Effect |
|---|---|
| **Reason to view** | User must enter a justification before revealing the secret |
| **Internal access** | Limits which internal (staff) users can see the credential at all — see below |
| **Visible to clients** | Controls whether the credential appears in the client portal |

## Controlling Internal User Access

Every credential has an **Internal access** panel on its detail page that controls which of your internal (non-client) users can see it. By default a credential is visible to **all internal users with company access**. You can instead restrict it to a hand-picked list.

Restriction here controls **visibility**, not just reveal: a user who is not on the list does not see the credential in the list, cannot open its detail page, and cannot reveal it. Reason-to-view (above) is a separate control that prompts for a justification before showing the secret to users who *do* have access.

### Setting Internal Access

1. Open the credential's detail page
2. In the **Internal access** panel, click **Edit**
3. Choose one of:
   - **All internal users with company access** — the default; anyone with normal access to the company can see the credential
   - **Restrict to selected internal users** — only the users you tick can see it
4. When restricting, tick the users who should retain access
5. Click **Save**

The panel summarises the current state: **All internal users** or **Restricted** with a count of how many users are allowed. When you are one of the allowed users, the panel notes that you're included.

### Who Can Be Selected

The user list is drawn from people who already have a path to the company:

- **Super admins** — always included and cannot be unticked (shown as *always included*)
- **Members** — operators and contractors with an active, unexpired membership for this company
- **Operators with global access** — operators whose global access setting already grants them every company

Each row shows the user's role and where their access comes from (membership, global access, or always included). If a previously selected user later loses eligibility (for example, their membership is revoked), the dialog flags them and offers a **Remove unavailable** action so you can save a clean list.

### Who Can Manage Internal Access

Editing internal access requires both write access to the company **and** the membership-management permission. Super admins always qualify. Other users without that permission can see the panel's current state but not the **Edit** button. The panel is also read-only on archived credentials.

## Linking to Articles and Assets

Passwords can be linked to articles and assets using the same relations system used by the rest of Weavestream.

1. Open the credential's detail page
2. Switch to the **Linked items** tab
3. Click **Add link** and search for any article or asset in the same company
4. Select the item to create the link

Links are **bidirectional** — the linked article or asset will also display the password in its own relations panel. This is useful for connecting credentials to the infrastructure records or runbooks they belong to.

File attachments (certificates, key files, configuration exports) can also be added directly from the password detail view via the **Attachments** tab.
