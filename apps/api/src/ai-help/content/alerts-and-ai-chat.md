# Alerts and AI chat

## Configure an email alert
<!-- aliases: new alert | alert configuration | expiration email | website down notification | record change alert | password alert -->
<!-- requires: alert.manage -->

Open **Admin → Alerts** and create an alert configuration. Each configuration has recipients, optional company scope, type-specific filters, and enabled/archived state. Outbound email and the background worker must be operational for delivery; use **Test** after changing a configuration or mail settings.

Available alert types:

| Type | Trigger |
|---|---|
| **Single expiration** | One notification per matching expiry item entering the selected window. |
| **Expiration list** | One daily digest of items inside the selected expiry window. |
| **Website down** | A monitored domain enters a new HTTP-down episode. |
| **Record created/updated/deleted** | A matching asset, article, password, or domain audit event occurs. |
| **Password created/updated** | A password create or update occurs. |

Expiration sources can include domain registration/TLS expiry, password expiry, and asset Date/Date-time fields that have **Expiry tracking** enabled. Use company scope when only one company’s domains or records should notify. Alerts are deduplicated, so repeated scheduled scans do not repeatedly send the same logical event.

## Maintain an alert configuration
<!-- aliases: disable alert | archive alert | test alert | alert recipients | alert scope | alert deduplication -->
<!-- requires: alert.manage -->

Use **Disable** to temporarily stop an alert without removing its configuration. Use **Archive** when it should no longer fire. Update recipients, scope, threshold, selected source kinds, or event filters as operational needs change, then run **Test** to verify the mail path. Alert create, update, archive, test, and successful delivery outcomes are audited.

For website-down alerts, a recovery followed by another outage is a new notification episode. For record and password alerts, each matching audit event is considered once. Alerts report conditions; open the matching asset, domain, password, or audit record to investigate and remediate rather than treating the email as proof of current state.

## Ask the AI for product help or company information
<!-- aliases: AI chat | chat panel | ask AI | product help | AI context | chat history | new chat -->
<!-- requires: article.read | asset.read -->

Open the AI chat panel from the chat icon in the company sidebar. The panel can be resized. Use **New chat** to start a separate conversation and the history control to reopen your previous conversations.

The assistant has two different read sources:

- **Product help**: release-matched instructions about Weavestream UI and required permissions. It cannot inspect or change your live setup.
- **Permission-scoped company data**: accessible records and selected context. A chat answer about a record is limited by the signed-in user’s permissions.

When viewing an asset or article, opening chat automatically attaches that item. Type `@` in the message box to attach accessible assets or articles in the current company; remove any item from the context strip before sending if it is not relevant. Chat may search/read permitted records, but it does not replace normal authorization checks or execute product configuration steps merely because it described them.

## Protect data before attaching it to an AI conversation
<!-- aliases: AI privacy | AI data sharing | AI provider | chat sensitive data | AI endpoint | self hosted model -->
<!-- requires: settings.manage -->

AI chat sends the conversation history and attached context to the configured OpenAI-compatible provider. Depending on what is attached, this can include full article content, visible asset fields, domain details, ticket bodies/notes, and user/company context. Choose a provider you are authorized to send that data to; Weavestream does not anonymize the attached material before sending it.

Authorized administrators configure the provider in **Admin → Settings → AI** with the provider base URL, model, and API credential. Private-network AI endpoints require an explicit private-network opt-in. Product help intentionally excludes deployment and secret-management instructions; use your organization’s approved operational runbooks for those tasks.

Do not attach a password merely to ask the AI to explain a linked asset. Use the asset or article context instead, and summarize only the necessary non-secret facts. The assistant treats attached text as context, but users should still avoid pasting unneeded credentials, personal information, or customer data.

## Use AI with articles safely
<!-- aliases: AI write article | draft article from chat | article edit proposal | accept AI article change -->
<!-- requires: article.write -->

With an article attached, ask the AI to draft, expand, rewrite, or format content. The assistant returns a proposed edit; review its tool card/diff before accepting. Accepted edits update the article, while stale or ambiguous exact-passage replacements are rejected for safety. You can also select **Save as article** on an assistant response and choose its title, folder, and editor format.

AI-generated text is a draft. Verify technical accuracy, client visibility, record links, and sensitive-data handling before publishing it to an article or client portal.
