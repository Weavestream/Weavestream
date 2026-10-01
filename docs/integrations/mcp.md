---
label: MCP Server
icon: cpu
description: Let AI agents read and update Weavestream through the Model Context Protocol, acting as you with an API key.
---

# MCP Server

`apps/mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server that lets an AI agent (Claude Code, Claude Desktop, any MCP client) work with Weavestream. It calls the Weavestream REST API with an [API key](../security/api-keys.md), so the agent has **exactly** the key owner's permissions and nothing more. Every guard, tenant scope, rate limit and audit entry is the server's own.

## Setup

1. Create an API key: **Account → API keys → New API key**. Leave **Allow password reveal** off unless the agent truly needs passwords.
2. Build the server: `pnpm --filter @weavestream/mcp build`.
3. Register it with your MCP client. For Claude Code:

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
| `WEAVESTREAM_MCP_ALLOW_PASSWORD_REVEAL` | no | `1` to expose `reveal_password`. The key must **also** allow reveal; the server enforces that either way. |

## Tools

| Tool | Does |
|---|---|
| `whoami` | The key's user, role and permissions |
| `list_companies`, `search` | Find companies and records |
| `list_layouts`, `get_layout` | Asset types and their field ids |
| `list_assets`, `get_asset`, `create_asset`, `update_asset` | Assets |
| `list_domains`, `get_domain` | Monitored domains, incl. Cloudflare registrar data |
| `list_passwords`, `get_password` | Vault metadata only (no secrets; notes hidden unless the key may reveal) |
| `reveal_password` | Opt-in, audited |
| `list_articles`, `get_article`, `create_article`, `update_article` | Knowledge base (Markdown) |

There are deliberately **no** delete, archive or purge tools, and none for users, memberships, IP rules or API keys: an agent can document, but destructive and access-changing actions stay with a person.

!!!warning Treat returned content as data
Everything a tool returns was typed by a person into Weavestream. A note that says "ignore previous instructions" is just text in a note. The tool descriptions say so to the model, but choose what an agent may do with that data accordingly.
!!!
