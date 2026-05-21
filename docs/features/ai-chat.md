---
label: AI Chat
icon: hubot
order: 810
description: OpenAI-compatible AI assistant with article editing, context attachment, and persistent chat history.
---

# AI Chat

Weavestream includes a built-in AI chat panel available on every company page. You can ask questions, draft documentation, and have the AI read and edit articles directly — all without leaving the context of the tenant you are working in.

## Opening the Chat Panel

Click the **chat icon** in the company sidebar toolbar to toggle the chat panel open or closed. The panel slides in from the right and can be resized by dragging its left edge.

## LLM Configuration

The AI chat requires an OpenAI-compatible language model endpoint. Configure this under **Admin → Settings → AI**:

| Setting | Description |
|---|---|
| **API Base URL** | The base URL of your OpenAI-compatible endpoint (e.g. `https://api.openai.com/v1`) |
| **Model** | The model identifier to use (e.g. `gpt-4o`, `gpt-4o-mini`) |
| **API Key** | Your API key for the endpoint |

Any provider that implements the OpenAI chat completions API is compatible, including self-hosted models via Ollama, LM Studio, or similar tools.

## Conversations & History

Each conversation is stored as a **chat session** tied to your user account. Sessions are persistent — you can close the panel and return to any previous conversation from the history popover.

| Action | How |
|---|---|
| **View history** | Click the clock icon at the top of the chat panel |
| **Resume a conversation** | Select it from the history list |
| **Start a new conversation** | Click **New chat** at the top of the panel |

## Context Attachment

The AI only has access to information you explicitly provide. You can attach context in two ways:

### Auto-attach

When you open the chat panel while viewing an asset or article, that record is **automatically attached** as context. An entry appears in the context strip above the message input showing what is attached.

### @-mention

Type `@` in the message input to open a picker and search for any article or asset in the current company. Selecting an item adds it to the context strip.

Multiple items can be attached to a single conversation. The context strip shows all attached items and allows you to remove individual ones.

## Article Editing

When an article is attached to the chat (either auto-attached or via @-mention), the AI can propose edits to it directly.

- Ask the AI to rewrite, expand, or fix sections of the article
- Proposed edits appear as **tool-call cards** in the chat — review the diff before accepting
- Accepted edits are applied directly to the article; the editor reflects the change immediately

### Save as Article

Any assistant response can be saved as a new article via the **Save as article** action at the bottom of the message. This opens a dialog to choose a title, folder, and format before creating the article.

## Privacy & Data

The following data is sent to your configured LLM endpoint when included in context:

- The full text content of attached articles
- The field values of attached assets (label and value pairs)

No other tenant data is transmitted. The LLM endpoint you configure is solely responsible for data handling under your own terms — Weavestream does not proxy requests through any Weavestream-operated service.
