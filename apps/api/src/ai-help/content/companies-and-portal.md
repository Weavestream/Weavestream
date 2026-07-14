# Companies and client portal

## Create, edit, and organize companies
<!-- aliases: new company | add client | new tenant | company settings | client information | parent company | company sticky note -->
<!-- requires: company.manage -->

A company is the top-level container for its articles, assets, passwords, domains, files, IPAM data, and memberships. Your workspace may call it a Client, Department, Site, or another configured term; the underlying scope is still one company.

Open **Admin → Companies** and select **New company**. Set a name, slug, type, contact details, address, logo, notes, and optional parent. Common types are Client, Prospect, Vendor, Internal, Partner, and Other. The parent setting creates an organizational hierarchy and cannot create a cycle.

Open a company’s **Settings** to update these details or configure a **Sticky note**. A sticky note is a short plain-text banner displayed throughout that company’s admin pages. Select Info, Warning, or Critical severity and keep the message focused on an operational reminder. Archive a company when it should no longer appear in normal navigation while its data must be retained; restore it from the archived view when needed.

## Control what a client portal user can see
<!-- aliases: client portal visibility | publish to client | show asset to client | client accessible content | portal content -->
<!-- requires: article.write | asset.write | password.write | domain.manage -->

Each company has a read-only portal at `/portal/<company-slug>`. A client user can see only content explicitly configured for client visibility:

| Content | Administrator control |
|---|---|
| Articles | Turn on **Visible to clients** for the individual article. |
| Assets | Turn on **Visible to clients** on each asset-layout field; portal responses omit all other fields. |
| Passwords | Turn on **Visible to clients** for the individual password; password reveal policy still applies. |
| Domains | Turn on **Visible to clients** on the domain. |
| Photos | Company image gallery, subject to company access. |
| IPAM | Read-only subnet, occupancy, reservation, and address-space views. |

Visibility flags supplement, rather than replace, company membership and password restrictions. A client-visible article may link to an internal-only password, but the link does not disclose it. Review a company using a real client-user account before publishing sensitive material.

## Invite users and decide their company access
<!-- aliases: create user | invite user | add client user | company membership | readonly company access | contractor access | client admin -->
<!-- requires: user.manage | membership.manage -->

Open **Admin → Users** to create a user. Deliver the one-time setup link through your approved channel. The recipient sets a display name and password, enrolls TOTP MFA, and then signs in. There is no self-registration.

Use **Admin → Memberships** or the company’s **Members** area to add a user to a company. Choose **Full** for company read/write access or **Read-only** for no mutations. For a contractor, set an expiry date; access stops immediately after it expires. A client user is portal-only and read-only; client administrators can manage other client users for their company, while client viewers consume the published portal content.

Do not interpret a company membership as permission to configure global areas such as layouts, users, integrations, audit, or settings. Those areas require their own platform capability.

## Understand roles, memberships, and platform capabilities
<!-- aliases: permissions | RBAC | super admin | operator | contractor | global access | capabilities | readonly user -->
<!-- requires: membership.read -->

Weavestream evaluates access in three layers:

- **Global role**: Super admin has full platform/company access. Operator access is derived from memberships and global access. Contractor access is membership-only and time-bound. Client user is portal-only and read-only.
- **Company membership**: Full allows company changes; Read-only allows company reads. An active explicit membership overrides an operator’s default global company access for that company.
- **Platform capability**: selected operators can manage global features without becoming super admin. Examples include Company management, Layout management, Integration management, User management, Membership management, Audit read, Settings management, Alerts, Security Center, Tags, export, and backups.

An Operator’s **global access** of Full, Read-only, or None applies only where that operator does not have an explicit membership. A Super admin does not need memberships. A contractor must have an unexpired membership. Client visibility controls what a client can see inside a company; it never grants membership by itself.

## Personalize terminology and quick access
<!-- aliases: rename company to client | tenant terminology | workspace settings | star company | favorite asset | favorites -->
<!-- requires: settings.manage -->

In **Admin → Settings**, authorized administrators can change the workspace name, subtitle, and company terminology (for example, Company to Client). This is cosmetic: URLs, API paths, and existing records still use company identifiers. Settings also define default password-generator options.

Star a company, asset, article, or password from its detail page to add it to your personal starred list. Stars are per-user, do not share with colleagues, and do not grant access. Use the sidebar star drawer or dashboard widget to return to starred records quickly.
