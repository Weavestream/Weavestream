---
label: Writing Articles
icon: note
order: 820
description: Author and organise documentation articles in Weavestream.
---

# Writing Articles

Weavestream's article editor is powered by Tiptap — a full-featured rich-text editor. This guide covers creating, formatting, and organising documentation.

## Creating an Article

1. Navigate to a tenant's **Articles** section
2. Click **New Article**
3. Enter a title
4. Choose an editor format (WYSIWYG or Markdown — see below)
5. Write your content in the editor
6. Click **Save**

## Choosing a Format

Each article has its own **editor mode** — you are not locked into a workspace-wide choice.

| Format | Best for |
|---|---|
| **WYSIWYG (Tiptap)** | Mixed content with tables, embedded images, and interactive task lists |
| **Markdown** | Technical runbooks, code-heavy docs, or content you want to manage as plain text |

To switch an existing article's format, use the **format toggle** in the article form. A confirmation dialog warns you before running the one-time conversion, because the process can be lossy for complex content. After switching, click **Save** — the format toggle does not autosave.

## Editor Toolbar

The toolbar provides quick access to all formatting options:

| Button | What it does |
|---|---|
| H1 / H2 / H3 | Heading levels |
| B / I / U | Bold, italic, underline |
| `code` | Inline code |
| `</>` | Code block (with syntax highlighting) |
| Table | Insert a resizable table |
| Image | Upload and embed an image |
| Link | Add or edit a hyperlink |
| — | Horizontal rule |
| ☑ | Task list (interactive checkboxes) |
| " | Block quote |

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| Cmd/Ctrl + B | Bold |
| Cmd/Ctrl + I | Italic |
| Cmd/Ctrl + K | Insert link |
| Cmd/Ctrl + Z | Undo |
| Cmd/Ctrl + Shift + Z | Redo |
| ` ``` ` + Enter | Code block |
| `#` + Space | Heading 1 |
| `##` + Space | Heading 2 |
| `-` + Space | Bullet list |
| `1.` + Space | Numbered list |
| `[]` + Space | Task list item |

## Inserting Images

1. Place your cursor where you want the image
2. Click the **Image** button in the toolbar (or drag-and-drop from your desktop)
3. The image is uploaded to the tenant's file store and embedded inline

Images are stored in the tenant's directory under `${FILE_STORAGE_DIR}/<tenantId>/uploads/...` and served through the API's same-origin streaming endpoint, so embedded `<img>` tags work without an external file host.

## Working with Tables

Click the **Table** button to insert a table. Right-click on any cell to access options:

- Add/remove rows and columns
- Merge or split cells
- Set header rows

## Organising with Folders

Articles can be organised into a folder hierarchy:

**Creating a folder:**
1. In the article list sidebar, click **New Folder**
2. Name the folder
3. Folders can be nested by dragging them into other folders

**Moving articles:**
1. Open the article
2. Change the **Folder** field in the article metadata panel
3. Save

**Root-level articles** (no folder) appear at the top of the list.

## Setting Client Visibility

To expose an article in the [client portal](/features/client-portal/):

1. Open the article
2. Toggle **Visible to clients** in the metadata panel
3. Save

The article will immediately appear in the portal for that tenant's client users.

## Searching Articles

Articles are indexed for full-text search via the command palette (Cmd+K) and the search API. The article title is weighted higher than the body, so descriptive titles improve discoverability.

## Tips for Good Documentation

- **Use headings** to structure long articles — they appear in the table of contents
- **Keep articles focused** — one topic per article is easier to search and navigate than a monolithic "everything" page
- **Use task lists** for runbooks and step-by-step procedures
- **Add images** for network diagrams, screenshots, and visual guides
- **Create a folder structure** that mirrors your infrastructure hierarchy (e.g. by region, by client, by service type)
