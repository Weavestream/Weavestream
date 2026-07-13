---
label: AI Chat
icon: hubot
order: 810
description: OpenAI-compatible AI assistant with article editing, context attachment, and persistent chat history.
---

# AI Chat

Weavestream includes a built-in AI chat panel available throughout the app. You can ask questions, retrieve permitted company documentation, get instructions for using Weavestream, and draft or edit articles without leaving your current workflow.

## Opening the Chat Panel

Click the **chat icon** in the company sidebar toolbar to toggle the chat panel open or closed. The panel slides in from the right and can be resized by dragging its left edge.

## LLM Configuration

The AI chat requires an OpenAI-compatible language model endpoint. Configure this under **Admin → Settings → AI**:

| Setting | Description |
|---|---|
| **API Base URL** | The base URL of your OpenAI-compatible endpoint (e.g. `https://api.openai.com/v1`) |
| **Model** | The model identifier to use (e.g. `gpt-4o`, `gpt-4o-mini`) |
| **API Key** | Your API key for the endpoint |
| **Allow private-network addresses** | Opt-in required for endpoints on loopback or LAN addresses (local Ollama, LM Studio). Off by default. |

Any provider that implements the OpenAI chat completions API is compatible, including self-hosted models via Ollama, LM Studio, or similar tools.

### Private network access

By default, Weavestream's server-side request guard refuses to connect to AI endpoints that resolve to private addresses — the same SSRF protection applied to every other outbound integration. If your LLM runs on your own machine or LAN (e.g. `http://localhost:11434/v1`), enable **Allow private-network addresses** in **Admin → Settings → AI**.

The opt-in permits only a curated set of private ranges (loopback, RFC1918, CGNAT/Tailscale, IPv6 loopback and unique-local). Link-local and cloud-metadata addresses (such as `169.254.169.254`) remain blocked even with the setting enabled, and DNS-rebinding protection stays active. Operators who need ranges outside the curated list can allow them process-wide via the `EGRESS_ALLOWED_PRIVATE_CIDRS` environment variable.

## Conversations & History

Each conversation is stored as a **chat session** tied to your user account. Sessions are persistent — you can close the panel and return to any previous conversation from the history popover.

| Action | How |
|---|---|
| **View history** | Click the clock icon at the top of the chat panel |
| **Resume a conversation** | Select it from the history list |
| **Start a new conversation** | Click **New chat** at the top of the panel |

## Product Help and Read Tools

For questions about using Weavestream itself—such as creating an asset layout, configuring an integration, mapping organizations, or running a sync—the assistant can retrieve release-matched instructions bundled with the deployed application. This app help is read-only: it explains the current UI and lists permissions that may be required, but it cannot inspect live integration state or perform the documented steps.

The assistant can also search records the signed-in user is permitted to access and read selected articles or relationships. Product help and tenant data are separate: static instructions do not prove that a particular asset, mapping, integration, or sync run exists.

If no app-help section qualifies with sufficient confidence, the assistant is instructed to say that the built-in help does not cover the question instead of guessing. Deployment, Docker, environment-variable, database, and server-administration guidance is intentionally excluded.

## Context Attachment

Attached context gives the assistant the current page or selected records immediately. The assistant may also use its permission-scoped read tools when a question needs other records. You can attach context in two ways:

### Auto-attach

When you open the chat panel while viewing an asset or article, that record is **automatically attached** as context. An entry appears in the context strip above the message input showing what is attached.

### @-mention

Type `@` in the message input to open a picker and search for any article or asset in the current company. Selecting an item adds it to the context strip.

Multiple items can be attached to a single conversation. The context strip shows all attached items and allows you to remove individual ones.

## Article Editing

When an article is attached to the chat (either auto-attached or via @-mention), the AI can propose edits to it directly.

- Ask the AI to rewrite, expand, or fix sections of the article
- Focused changes use exact passage replacements, so the model does not need to reproduce the unchanged article
- Explicit whole-article rewrites can still replace the complete document
- Proposed edits appear as **tool-call cards** in the chat — review the generated diff before accepting
- Accepted edits are applied directly to the article; the editor reflects the change immediately
- If the article changed after the proposal, or an original passage is missing or ambiguous, Apply safely refuses the edit

### Save as Article

Any assistant response can be saved as a new article via the **Save as article** action at the bottom of the message. This opens a dialog to choose a title, folder, and format before creating the article.

## Privacy & Data

AI chat sends your conversation and its attached context directly to the LLM endpoint you configure. Depending on what is attached, a single request can include:

- The full markdown content of attached articles
- The field values of attached assets (label and value pairs, as visible to the requesting user)
- Attached domain records (WHOIS/DNS/TLS/email-auth details)
- Attached ticket bodies fetched in real time from your ticketing integration (NinjaOne), **including internal notes**
- The acting user's email address, user id, and role, plus the active company id
- The conversation history of the current chat session

Context is only attached when you (or the auto-attach behaviour of the page you are on) add it — but once attached, it is transmitted in full. The LLM endpoint you configure is solely responsible for data handling under its own terms — Weavestream does not proxy requests through any Weavestream-operated service, and it does not filter or anonymise the content before sending. Choose a provider you trust with your client documentation, or self-host the model.
