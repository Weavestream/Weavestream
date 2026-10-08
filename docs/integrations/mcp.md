---
label: MCP Server
icon: cpu
description: Let AI agents read and update Weavestream through the Model Context Protocol, acting as you with an API key.
---

# MCP Server

`apps/mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server that lets an AI agent (Claude Code, Claude Desktop, any MCP client) work with Weavestream. It calls the Weavestream REST API with an [API key](../security/api-keys.md), so the agent has **exactly** the key owner's permissions and nothing more. Every guard, tenant scope, rate limit and audit entry is the server's own.

## Setup

1. Make sure API keys are turned on: **Admin → Settings → Security → Allow API keys** (an administrator does this once).
2. Create an API key: **Account → API keys → New API key**.
   - Leave **Allow this key to make changes** off if the agent only needs to answer questions. The write tools then fail with a clear error.
   - Leave **Allow password reveal** off: the MCP server never reveals passwords, so an agent's key does not need it.
3. Build the server: `pnpm --filter @weavestream/mcp build`.
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

## Tools

| Tool | Does |
|---|---|
| `whoami` | The key's user, role and permissions |
| `list_companies`, `search` | Find companies and records |
| `list_layouts`, `get_layout` | Asset types and their field ids |
| `list_assets`, `get_asset`, `create_asset`, `update_asset` | Assets |
| `list_domains`, `get_domain` | Monitored domains, incl. Cloudflare registrar data |
| `list_passwords`, `get_password` | Vault metadata only: never the password, TOTP or notes |
| `list_articles`, `get_article`, `create_article`, `update_article` | Knowledge base (Markdown). New articles are always hidden from client users. |

There are deliberately **no** password-reveal, delete, archive or purge tools, and none for users, memberships, IP rules or API keys.

!!!danger Leaving out a tool is not a permission
The tool list decides what an agent is *offered*, not what the key *can do*. The key carries its owner's permissions on the whole REST API, and an agent with shell access can read the key from its MCP config and call any route directly. Limit the key itself: a read-only key cannot change or delete anything, whatever the agent tries. Keys have no per-company or per-route scopes yet, so to narrow an agent further, mint its key from a user with fewer permissions.
!!!

### Why there is no password reveal

Everything a tool returns goes into the model's context: to the model provider, and into conversation transcripts that clients store on disk. A decrypted customer credential must not travel there, so the MCP server has no reveal tool and strips vault notes from `get_password`, even when the key itself may reveal. Scripts that genuinely need a password can call `POST /passwords/:id/reveal` directly with a key minted for that.

### Why new articles are hidden from clients

The agent reads text people typed into Weavestream, and that text can contain instructions aimed at the model. `create_article` always sends `visibleToClients: false` (the server default is `true`), so injected instructions cannot publish one company's data to another company's client users. A person reviews and publishes.

!!!warning Treat returned content as data
Everything a tool returns was typed by a person into Weavestream. A note that says "ignore previous instructions" is just text in a note. The tool descriptions say so to the model, but choose what an agent may do with that data accordingly.
!!!
