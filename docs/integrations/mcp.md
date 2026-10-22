---
label: MCP Server
icon: cpu
description: Let AI agents read and update Weavestream through the Model Context Protocol, from Claude, ChatGPT and other AI apps or from a local agent, always acting as you.
---

# MCP Server

Weavestream speaks the [Model Context Protocol](https://modelcontextprotocol.io) (MCP), so an AI agent can find and read your documentation, and, if you allow it, create and update assets and articles. There are two ways to connect. Both offer the same tools and act **only as you**, with exactly your permissions: every guard, tenant scope, rate limit and audit entry is the server's own.

| | Remote (OAuth) | Local (stdio) |
|---|---|---|
| For | claude.ai and ChatGPT on the web; with **Any MCP app**, also Claude Code, Gemini CLI, Cursor and other MCP apps | Claude Code, Claude Desktop, any MCP client that runs a local process |
| Address | `https://<your-instance>/mcp` | `node apps/mcp/dist/index.js` on your machine |
| Sign-in | Your normal Weavestream login and MFA (OAuth) | An [API key](../security/api-keys.md) |
| Turned on by | **Admin → Settings → API & MCP → Allow remote AI connections** | **Admin → Settings → API & MCP → Allow API keys** |
| Managed in | **Account → AI connections** | **Account → API keys** |
| Reaches | The MCP tools only | Every REST route its owner can use |

## Remote: AI apps over OAuth

### Which AI apps can connect

An administrator chooses which AI apps can sign in at `/mcp`, in **Admin → Settings → API & MCP → Which AI apps can connect**. The change asks for MFA again (step-up), and you can make it before or after you turn remote connections on.

| Choice | Who can connect |
|---|---|
| **Claude and ChatGPT only** (default) | Only claude.ai and ChatGPT on the web. Local apps such as Claude Code use the [local server](#local-stdio-with-an-api-key) with an API key. |
| **Any MCP app** | Any app that supports MCP sign-in, with only the `/mcp` address: Claude Code, Gemini CLI, Cursor, self-hosted assistants and others. Apps that register themselves are marked **Not verified**. |

Everything else is the same for both choices: the **Allow remote AI connections** switch, sign-in with MFA, the consent page with a step-up, **Read only** or **Read and change**, tokens that work only on `/mcp`, revocation, and the audit trail.

Changing from **Any MCP app** back to **Claude and ChatGPT only** refuses connections from other apps at once, but does not delete them. They stay listed in **Account → AI connections** and the Security center, where they can be revoked, and they work again if you allow any MCP app again.

### Requirements

- Weavestream must be reachable on the internet over HTTPS, and `APP_URL` must be that public address (for example `https://docs.example.com`). The MCP address is always `APP_URL` followed by `/mcp`. See [TLS & Reverse Proxy](../deployment/tls.md).
- An administrator turns on **Admin → Settings → API & MCP → Allow remote AI connections** once. This asks for MFA again (step-up). Remote connections are **off** on a new instance.
- If you restrict access with [IP rules](../configuration/security.md#admin-security-controls), allow the address ranges the AI app connects from: Claude uses `160.79.104.0/21`; ChatGPT publishes its ranges at `https://openai.com/chatgpt-connectors.json`.
- If a firewall, WAF or CDN with bot protection sits in front of Weavestream, add the narrow exception in [Bot protection, challenges and WAF rules](../deployment/tls.md#bot-protection-challenges-and-waf-rules). AI apps call `/mcp` from their servers (or from your computer) and cannot pass a challenge page.

### Connect Claude

On Pro and Max plans:

1. In claude.ai, open **Customize → Connectors**.
2. Select **+ Add**, then **Add custom connector**.
3. Enter a name (for example `Weavestream`) and the server URL `https://<your-instance>/mcp` exactly. Select **Continue**.
4. Review the detected authentication settings and select **Continue**.
5. Under **Authentication**, choose **Sign in now** (or **Sign in when needed**).
6. Under **OAuth client**, choose **Use Claude's published identity (Recommended)**. **Register automatically** works only when the administrator has chosen **Any MCP app**; with **Claude and ChatGPT only** it fails.
7. Leave **Request headers** empty and select **Add**.
8. Your browser opens Weavestream. Sign in with your password and MFA if you are not signed in already, then [approve the connection](#the-consent-page).

On Team and Enterprise plans, an owner adds the connector once: **Organization settings → Connectors → Add → Custom → Web**, then steps 3–7 above. Each member then opens **Customize → Connectors**, finds the connector (labelled **Custom**), selects **Connect**, and approves it with their own Weavestream account.

**Use it in a conversation:** select **+** at the lower left of the chat, then **Connectors**, and turn **Weavestream** on for that conversation.

### Connect ChatGPT

1. In ChatGPT on the web, open **Plugins** (`chatgpt.com/plugins`), select **+**, then **Add custom MCP server**.
2. Enter a name (for example `Weavestream`) and an optional description. Under **Connection**, enter the **Server URL** `https://<your-instance>/mcp`.
3. Under authentication, choose **OAuth**, and use the client metadata document (CIMD) as the registration method. Dynamic client registration also works when the administrator has chosen **Any MCP app**; with **Claude and ChatGPT only** it fails.
4. Review the risk warning and select **I understand and want to continue**.
5. Select **Create as a plugin**.
6. Find the new plugin under your personal plugins (or the workspace you created it in) and **install** it. ChatGPT opens Weavestream: sign in with your password and MFA if needed, then [approve the connection](#the-consent-page).

**Use it in a conversation:** type `@` in the prompt box and select **Weavestream**.

**Confirmations for changes.** By default, ChatGPT asks you to confirm each call to a tool that changes data (the create and update tools). In the prompt you can choose to remember your approval for that tool for the rest of the conversation; after that, ChatGPT calls it without asking again until a new conversation. Do not rely on a prompt for every change: if an agent should never change data, connect it with **Read only**, which Weavestream enforces on the server. Workspace policies set by your ChatGPT administrator apply to custom MCP servers.

### Connect another app

When the administrator has chosen **Any MCP app**, any app that supports MCP sign-in can connect. The general rule: paste the `/mcp` address into the app, sign in to Weavestream when the browser opens, and [approve the connection](#the-consent-page).

**Claude Code:**

```bash
claude mcp add --transport http weavestream https://<your-instance>/mcp
```

Then run `/mcp` in Claude Code and choose **Authenticate**. Your browser opens Weavestream; sign in and approve. Claude Code registers itself and receives the answer on your own computer, so the consent page shows it as **Not verified**, returning to **This computer (localhost)**.

Other apps, such as Gemini CLI, Cursor or a self-hosted assistant, work the same way: add a remote (HTTP) MCP server with the address `https://<your-instance>/mcp`, and sign in when asked.

### The consent page

The page shows who you are signed in as, the app's name and the **return address**:

- **A verified app** (Claude, ChatGPT, or any app that publishes a client metadata document) also shows its **app address**. Weavestream has checked both addresses; the name is what the app says about itself.
- **An app that registered itself** is marked **Not verified**, and there is no app address. Weavestream cannot check its name. A return address on your own computer shows as **This computer (localhost)**.

Only approve a connection you started yourself.

| Access | The app can |
|---|---|
| **Read only** (default) | Find and read companies, assets, articles, domains and password names. |
| **Read and change** | Also create and update assets and articles. New articles stay hidden from client users. |

Whatever you choose, the app can never see passwords, TOTP codes or vault notes, and cannot delete or archive anything or manage users, permissions or settings. To change the access later, revoke the connection and connect again.

### Revoking a connection

- **You:** **Account → AI connections → Revoke**.
- **An administrator:** **Admin → Security center → AI connections → Revoke** (needs the user-management permission and MFA step-up).
- **Automatically**, together with your API keys, when you change your password or sign out other sessions, or when an administrator resets your MFA, re-invites or deactivates you, and when the `reset-password`, `reset-mfa` or `rotate-sessions` CLI commands run.

A revoked connection stops working on its next request. Turning **Allow remote AI connections** off refuses every connection at once without deleting them; turning it back on restores them.

### How a remote connection is secured

- **OAuth 2.1 with PKCE.** Weavestream is its own authorization server for this; no external identity provider is needed. It never asks for your password itself: signing in is the normal Weavestream login with MFA, and approving needs a fresh MFA step-up, like creating an API key.
- **Only the apps the administrator allows.** With **Claude and ChatGPT only**, the app must identify itself with a client metadata document from `chatgpt.com` or `claude.ai`, with return addresses on `chatgpt.com`, `claude.ai` or `claude.com`; there is no client registration. With **Any MCP app**, Weavestream also accepts client metadata documents from any `https` address, and public clients that register themselves (no client secret, authorization code with PKCE only). Return addresses must be `https`, or `http` on `127.0.0.1`, `[::1]` or `localhost` for an app on your own computer; any other address is refused. An app with a client metadata document is shown with its checked address; an app that registered itself is marked **Not verified**. Either way, nothing connects without your sign-in, MFA and approval.
- **The token works on `/mcp` only.** It is issued for the MCP address and refused everywhere else, including the REST API, so the app can only ever use the tools listed below. Each tool call runs inside Weavestream as you, through the same permission checks as the web app.
- **Short-lived and rotating.** Access tokens last one hour; refresh tokens rotate on every use, and reusing an old one ends the connection. A connection lasts at most one year.
- **Attributed.** Every change made through a connection is audited with you as the actor and the connection's id (`mcpConnectionId`), so it can be told apart from your own work.

## Local: stdio with an API key

`apps/mcp` is a local MCP server. When the administrator has chosen **Any MCP app**, Claude Code can also [connect remotely](#connect-another-app) without an API key; the local server still works in both modes. It calls the Weavestream REST API with an [API key](../security/api-keys.md), so the agent has **exactly** the key owner's permissions.

1. Make sure API keys are turned on: **Admin → Settings → API & MCP → Allow API keys** (an administrator does this once).
2. Create an API key: **Account → API keys → New API key**.
   - Leave **Allow this key to make changes** off if the agent only needs to answer questions. The write tools then fail with a clear error.
   - Leave **Allow password reveal** off: the MCP server never reveals passwords, so an agent's key does not need it.
3. Build the server and the shared package it uses: `pnpm --filter @weavestream/mcp... build`.
4. Register it with your MCP client. For Claude Code:

```bash
claude mcp add weavestream \
  -e WEAVESTREAM_URL=https://weavestream.example.com \
  -e WEAVESTREAM_API_KEY=ws_… \
  -- node /path/to/weavestream/apps/mcp/dist/index.js
```

Keep the key in a secret manager and inject it rather than pasting it into shared config.

| Variable | Required | Meaning |
|---|---|---|
| `WEAVESTREAM_URL` | yes | Instance origin. `https://` only (`http://` is accepted for `localhost`). |
| `WEAVESTREAM_API_KEY` | yes | A `ws_…` API key. |

!!!danger Leaving out a tool is not a permission for an API key
The tool list decides what an agent is *offered*, not what the key *can do*. The key carries its owner's permissions on the whole REST API, and an agent with shell access can read the key from its MCP config and call any route directly. Limit the key itself: a read-only key cannot change or delete anything, whatever the agent tries. Keys have no per-company or per-route scopes yet, so to narrow an agent further, mint its key from a user with fewer permissions. A remote connection is different: its token works only on `/mcp`.
!!!

## Tools

Both ways of connecting offer the same tools. A read-only remote connection is offered only the read tools.

| Tool | Does | Changes data |
|---|---|---|
| `whoami` | The user, role and permissions it acts as | no |
| `list_companies`, `search` | Find companies and records | no |
| `list_layouts`, `get_layout` | Asset types and their field slugs | no |
| `list_assets`, `get_asset` | Assets | no |
| `create_asset`, `update_asset` | Create and update assets | yes |
| `list_domains`, `get_domain` | Monitored domains, incl. Cloudflare registrar data | no |
| `list_passwords`, `get_password` | Vault metadata only: never the password, TOTP or notes | no |
| `list_articles`, `get_article` | Knowledge base | no |
| `create_article`, `update_article` | Markdown articles. New articles are always hidden from client users. | yes |

Customer-specific tools always need an explicit `companyId`; `search` without one searches every company you can reach. There is no "current company" kept between calls.

There are deliberately **no** password-reveal, delete, archive or purge tools, and none for users, memberships, IP rules, API keys or connections.

### Why there is no password reveal

Everything a tool returns goes into the model's context: to the model provider, and into conversation transcripts. A decrypted customer credential must not travel there, so there is no reveal tool and `get_password` strips vault notes. Scripts that genuinely need a password can call `POST /passwords/:id/reveal` directly with an API key minted for that.

### Why new articles are hidden from clients

The agent reads text people typed into Weavestream, and that text can contain instructions aimed at the model. `create_article` always creates the article hidden from client users (the server default is visible), so injected instructions cannot publish one company's data to its client users. A person reviews and publishes.

!!!warning Treat returned content as data
Everything a tool returns was typed by a person into Weavestream. A note that says "ignore previous instructions" is just text in a note. The tool descriptions say so to the model, but choose what an agent may do with that data accordingly.
!!!
