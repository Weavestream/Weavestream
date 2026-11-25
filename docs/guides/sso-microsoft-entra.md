---
label: Microsoft Entra SSO
icon: shield-lock
order: 590
description: Set up sign-in with Microsoft Entra ID from scratch, step by step, using the Weavestream settings page.
---

# Set up Microsoft Entra single sign-on

This guide gets people signing in to Weavestream with their Microsoft work accounts. You do everything in two places: the Microsoft Entra admin center and **Admin → Settings → Single sign-on** in Weavestream. No server access or environment variables are needed.

You need to be a Weavestream super admin (or an operator with the settings capability) and an Entra administrator who can register applications.

> If your deployment sets `SSO_OIDC_ISSUER` in its environment, the settings tab is read-only and says "Managed by environment variables". The environment wins. See [Environment variables](/configuration/environment/#single-sign-on-oidc).

Throughout, replace the placeholders with your own values: `<tenant-id>`, `<client-id>`, `<secret-value>` and `<weavestream-api-url>`.

## Before you start

1. In Weavestream, open **Admin → Settings → Single sign-on**.
2. Copy the **Callback URL** (the **Copy** button). It looks like `<weavestream-api-url>/v1/auth/sso/callback`. You will paste it into Entra in step 2.

If the callback URL looks wrong (for example `localhost`), the deployment's `API_URL` is not set to the public address. Fix that first, because Entra must send people back to a URL they can reach.

## 1. Register the application (single tenant)

1. In the [Entra admin center](https://entra.microsoft.com), go to **Entra ID → App registrations → New registration**.
2. Name it, for example `Weavestream`.
3. Under **Supported account types** choose **Accounts in this organizational directory only (Single tenant)**. Do not pick a multi-tenant option: Weavestream refuses `common`, `organizations` and `consumers` issuers, because anyone's email address can be claimed in another tenant.
4. Leave the redirect URI empty for now and select **Register**.
5. On the **Overview** page note the **Application (client) ID** (`<client-id>`) and the **Directory (tenant) ID** (`<tenant-id>`).

## 2. Add the redirect URI

1. Open **Authentication → Add a platform → Web**.
2. Paste the **Callback URL** you copied from Weavestream as the **Redirect URI**.
3. Leave implicit grant and hybrid flow options **unticked**. Weavestream uses the authorization code flow with PKCE.
4. Select **Configure**.

The URL must match exactly, including `https` and no trailing slash differences. A mismatch shows up at Microsoft's sign-in page as an error naming the redirect URI.

## 3. Create a client secret

1. Open **Certificates & secrets → Client secrets → New client secret**.
2. Choose a description and an expiry.
3. Copy the secret **Value** (`<secret-value>`) straight away. Entra shows it only once. Do not copy the **Secret ID**.
4. Note the expiry date somewhere you will see it. When the secret expires, nobody can sign in with SSO until you replace it (see [Troubleshooting](#troubleshooting)).

## 4. Add the optional claims (recommended)

Open **Token configuration → Add optional claim → ID** and add:

| Claim | Why |
|---|---|
| `email` | Lets Weavestream match a first sign-in to an existing user by email. |
| `xms_edov` | Microsoft's "the email's domain is owned by this tenant" proof. Weavestream only links by email when it is true. |
| `auth_time` | Needed so Weavestream can ask people to re-confirm with Microsoft before sensitive actions (step-up). |

When Entra offers to add the Microsoft Graph `email` permission, accept. These claims are optional, and without them people can still sign in once their account is linked.

## 5. Assign people to the application

By default every user in your directory can start a sign-in. To limit it:

1. Go to **Entra ID → Enterprise applications**, open the application, then **Properties**.
2. Set **Assignment required?** to **Yes** and save.
3. Open **Users and groups → Add user/group** and assign the people or groups who should use Weavestream.

Someone who is not assigned is turned back at sign-in with "not allowed".

## 6. Enter the values in Weavestream

In **Admin → Settings → Single sign-on**:

1. Paste the **Directory (tenant) ID** into **Microsoft Entra tenant ID** and select **Use for Entra**. This fills in the **Issuer URL** (`https://login.microsoftonline.com/<tenant-id>/v2.0`) and, if it was empty, **Allowed tenant ID**.
2. Paste the **Application (client) ID** into **Client ID**.
3. Paste `<secret-value>` into **Client secret**.
4. Set **Provider name** to what people should see, for example `Microsoft`. The button will read "Sign in with Microsoft".
5. Leave **Scopes** as it is.
6. Choose the account rules (you can change them later):
   - **Link accounts by email**: turn on if your people already have Weavestream accounts and you added the `email` and `xms_edov` claims. Super admins are never linked this way (step 8).
   - **Create accounts automatically**: turn on only if anyone assigned in Entra should get an account. New accounts have no access until you grant it.
   - **Trust the provider's multi-factor sign-in**: turn on if Entra enforces MFA for these people (for example Conditional Access). Weavestream then skips its own two-factor code for those sessions. If Entra does not report MFA, Weavestream still asks for its own code.
7. Leave **Allow password sign-in** on for now.
8. Turn on **Enable single sign-on** and select **Save single sign-on settings**. Confirm with your usual two-factor code or password when asked.

The tab refuses to save an incomplete or unsafe setup and tells you which field to fix.

## 7. Test the connection

Select **Test connection**. It checks, from the Weavestream server, that:

- the issuer answers with a discovery document,
- the document names exactly the issuer you entered,
- the sign-in and token addresses use https, and
- the provider's signing keys can be fetched.

It does not sign anyone in, and it **cannot** check that the callback URL is registered in Entra. That is what step 2 was for. The test only reaches public internet addresses.

## 8. Link your own admin account

Super admins are never linked by email, so link yours yourself. This is also what makes it safe to turn off password sign-in later.

1. Sign out, then on the login page choose **Sign in with Microsoft** to confirm the button appears and Microsoft's page loads. (If you are not yet linked you will see "no account". That is expected.)
2. Sign in the usual way (password and two-factor code), then open **My account → Security → Single sign-on**.
3. Choose **Link Microsoft account**, confirm when asked, and pick your work account at Microsoft.
4. You return to **My account** with a message that the account is linked.
5. Sign out and use **Sign in with Microsoft** again. You should land in Weavestream.

Everyone else is linked automatically on first sign-in (if you enabled **Link accounts by email**), or can link themselves from the same place.

If you are asked to set up or enter a two-factor code right after a Microsoft sign-in, Entra did not tell Weavestream that MFA happened. That is normal when **Trust the provider's multi-factor sign-in** is off, or when Entra does not send the `amr` claim. Complete the Weavestream two-factor step as usual.

**Entra sends no `amr` claim.** Entra v2 ID tokens normally carry no `amr`, so Weavestream cannot see that MFA happened even when it did. You have two options:

- **Keep the Weavestream two-factor prompt.** Nothing to change. The safest choice.

## 9. Optionally turn off password sign-in

Once at least one super admin has signed in and linked through SSO:

1. Return to **Admin → Settings → Single sign-on**.
2. Untick **Allow password sign-in** and save.

Everyone except super admins must now use Microsoft. Passwords of non-super-admins stop working immediately, including sessions already open.

Weavestream refuses to save this (a "conflict" message) until an active super admin is linked at this provider, so you cannot lock everyone out by accident.

### Break-glass

Super admins keep password sign-in on purpose, so that a broken Entra setup, an expired client secret or an Entra outage cannot lock you out. To keep that safe:

- Keep at least one super admin with a known password **and** working two-factor code or backup codes, stored somewhere safe.
- To recover, sign in with that account using a password, then fix or replace the SSO settings. You can also turn single sign-on off completely from the same tab.
- If nobody can sign in at all, use the [super admin recovery CLI](/security/authentication/#super-admin-recovery-cli).

## Troubleshooting

Sign-in problems send the browser back to the login page with a short message. Weavestream deliberately keeps these generic. The detail is in the audit log (`auth.sso.login.failure`, with a fixed reason code, never a token) and the API log.

| What you see | Likely cause | What to do |
|---|---|---|
| "Not allowed" (`not_allowed`) | The person is not assigned to the enterprise application (step 5), declined consent, the token came from a different tenant than **Allowed tenant ID**, the matching user is inactive or has an unaccepted invite, or the match is a super admin (see next rows). The audit log has the exact reason. | Assign them in Entra, check **Allowed tenant ID** matches your tenant, or fix the user. |
| "No account" (`no_account`) | Nobody matches, and **Create accounts automatically** is off. Or **Link accounts by email** is off, or the `email` or `xms_edov` claim is missing. | Link the user from My account, ask an admin to create the user, or fix the claims and switch on linking or auto-create. |
| Super admin gets "Not allowed", audit reason `privileged_account` | Super admins and accounts with platform capabilities are never linked by email, on purpose. | Link from **My account → Security → Single sign-on** (step 8). |
| "expired" (`expired`) | The sign-in took longer than 10 minutes, the browser blocked cookies, or the page was reloaded. | Start again from the login page. |
| "Failed" (`failed`), audit reason `token_exchange_failed` | Most often the client secret is wrong or has expired (the provider's reply is deliberately not recorded). | Create a new secret (step 3), then in the tab choose **Replace**, paste it, save. |
| Microsoft shows "redirect URI does not match" | The redirect URI in Entra differs from the Callback URL. | Copy the Callback URL again into **Authentication → Web** (step 2). |
| Test connection says the issuer differs | The Issuer URL is not exactly what the provider announces. | For Entra use `https://login.microsoftonline.com/<tenant-id>/v2.0`, with the `/v2.0`. |
| Test connection says the address is not allowed | The issuer resolves to a private, loopback or link-local address. | Use the provider's public address. |
| Save refused: "Local login cannot be turned off yet" | No active super admin is linked at this provider. | Complete step 8 first. |
| A step-up asks you to sign in at Microsoft again | You use SSO without Weavestream two-factor, so sensitive actions re-confirm with Microsoft. | Expected. The `auth_time` claim (step 4) must be added for this to work. |

The sign-in button is missing from the login page when SSO is off, incomplete, or when the saved client secret cannot be read (for example after a key change). Open the tab and save the secret again.
