# Password vault

## Create and organize a password
<!-- aliases: new password | add credential | password vault | save login | password folder | tags on passwords -->
<!-- requires: password.write -->

Open a company’s **Passwords** area and select **New password**. Provide a descriptive **Name** and the required secret, then optionally add Username, URL, TOTP secret, Notes, Expiry date, Folder, and Tags. Save the record. Passwords are encrypted at rest; do not use notes as a replacement for access control.

Use folders to organize credentials by service, system, or team. Create folders from the vault sidebar, assign a folder in the password form, and use folder settings to rename or archive a folder. Archiving a folder archives the passwords inside it; **Show archived** exposes archived content so it can be restored. Tags are an additional cross-folder classification and are shared with asset tags.

Use the built-in generator from the password input to create a **Words + symbols**, **Passphrase**, or **Custom length** password. The generated value is placed in the form. The strength meter reports strength and suggestions. After create/update, breach checking may mark known-compromised values using a privacy-preserving hash-prefix check.

## Reveal, copy, and use TOTP credentials
<!-- aliases: show password | copy password | reveal secret | reason to view | authenticator code | TOTP code -->
<!-- requires: password.reveal -->

Open a password and select **Reveal**, or use its copy action to copy the password without leaving it visible. If **Reason to view** is enabled, enter a justification before the secret is disclosed. Plaintext is only temporarily shown; every reveal and reveal-based copy is audited with the actor and time.

When a password has a TOTP secret, its detail view can generate the current one-time code and countdown. Copy Username, Password, URL, or TOTP using their adjacent copy controls. Copying/revealing still requires authorization; it is not a way around the password’s visibility restriction.

## Restrict a sensitive password and publish it safely
<!-- aliases: password access restriction | internal access | restrict credential users | visible to clients | client portal password -->
<!-- requires: password.write | membership.manage -->

Every internal user with company access can see a password by default. On the password detail page, open **Internal access → Edit** and choose either **All internal users with company access** or **Restrict to selected internal users**. For a restriction, select the internal users who should retain access and save.

Eligible selections are derived server-side: super admins (always included), active operator/contractor company members, and operators with global company access. A person who loses company eligibility cannot continue to access the password even if previously selected. This restriction controls list visibility, detail access, and reveal access; it is separate from **Reason to view**, which asks allowed viewers for a justification.

Turn on **Visible to clients** only when the credential may be shown in the portal and the client role/access policy allows it. Client visibility does not weaken Internal access or reason-to-view controls. Never publish an internal-only credential through an article; use the password’s own portal setting and audit trail.

## Link passwords to assets, articles, and files
<!-- aliases: password linked items | credential attachment | link password to asset | attach certificate to password | embedded credentials -->
<!-- requires: password.write | relation.write | upload.create -->

Open a password and use **Linked items → Add link** to connect it to an asset or article in the same company. The relationship is bidirectional and appears on the other record’s **Linked items** panel. It is appropriate for connecting a router login to the router asset or a service account to its runbook. A link does not grant a user password visibility or plaintext reveal rights.

Use the password’s **Attachments** tab for related files such as certificates, key material, configuration exports, or handover documents. File access remains company-authorized. From an asset’s Credentials panel, create a password directly attached to that asset; archiving that asset soft-archives directly embedded passwords.

## Review password history and remove a credential
<!-- aliases: password version history | password changes | archive password | restore password | delete credential -->
<!-- requires: password.write | password.archive -->

Every password update creates an immutable version record. Open **History** on the credential to see prior changes, actor, and time. The history retains metadata without placing plaintext secrets into the audit log.

Use the password actions to **Archive** a credential when it is no longer active. Archived passwords retain their history and can be restored from the archived view. Archiving is preferable to deleting an old or rotated credential when an audit trail is required.
