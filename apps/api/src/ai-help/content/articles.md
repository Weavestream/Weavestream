# Articles and folders

## Create an article and choose an editor format
<!-- aliases: new article | knowledge base article | documentation page | markdown article | rich text article | change article format -->
<!-- requires: article.write -->

Open a company’s **Articles** area and select **New article**. Enter a title, select a folder or leave it at the root, choose the format, write the content, and select **Save**.

Each article uses one of two formats:

- **Rich text** is a Tiptap editor for headings, inline formatting, tables, images, code blocks, task lists, links, quotes, and horizontal rules. Choose it for visual runbooks and mixed content.
- **Markdown** stores plain CommonMark/GFM source. It supports fenced code blocks, tables, task lists, and strikethrough. Choose it for technical documents or source-oriented authoring.

Use the format toggle to convert an existing article. Confirm the conversion, then explicitly save; switching formats does not autosave. Conversion can be lossy for complex rich-text content, so review the result before saving. Both formats are indexed as plaintext for search.

## Add links, mentions, images, and tables to an article
<!-- aliases: embedded link | link an article | article mention | @ mention | link asset in article | link password in article | embed image | article table -->
<!-- requires: article.write | relation.write | upload.create -->

In a rich-text article, use the toolbar or **Cmd/Ctrl+K** to create a normal hyperlink. For an in-app link to another company record, type `@` in the editor and select an accessible **asset**, **article**, or **password** from the current company. The resulting mention is a clickable in-app record link. It does not grant access: the viewer must already be authorized for that target.

For a durable two-way relationship, use the article’s **Linked items** panel instead of, or in addition to, an inline mention:

1. Open the article (or its editor) and open **Linked items**.
2. Select **Add link**.
3. Search assets, articles, or passwords in the same company.
4. Select the target.

The link appears on both records. It is useful for associating a runbook with a system or credential without exposing a secret in the article body. Remove the link from either item to remove the relation only.

Use the **Image** toolbar action or drag-and-drop to upload and embed an image. Images are stored with the company and are authorization-checked when viewed. Use the Table toolbar action for a resizable table; its cell menu can add/remove rows or columns, merge/split cells, and set a header row.

## Organize articles with folders and client visibility
<!-- aliases: article folder | move article | nested folders | client visible article | publish article to portal | internal article -->
<!-- requires: article.write -->

Articles can remain at the root or belong to a folder. In the Articles sidebar, use **New Folder** to create a folder. Folders can be nested. Move an article by changing its **Folder** setting in article metadata and saving. Use the folder settings action to rename it or manage its contents before archiving.

Articles are internal by default. Turn on **Visible to clients** in the article metadata and save to publish that article in the company’s client portal. This setting controls only the article itself; linked assets, passwords, and files retain their own portal visibility and authorization requirements. Do not put credentials or internal-only details in a client-visible article merely because a linked record is restricted.

## Review history, archive, restore, and permanently delete articles
<!-- aliases: article version history | restore article version | archive article | delete article | purge article -->
<!-- requires: article.write | article.purge -->

Open an article and use **History** to inspect saved versions. A user with write access can restore a selected version; the restore writes a new current version rather than erasing history. Use version restore for accidental edits or to recover a previous document state.

Use the article actions to **Archive** an article, which removes it from normal lists while retaining it for recovery. Turn on the archived view in the browser to find it and choose **Restore**. **Permanently delete** is irreversible, available only after archiving, and requires step-up authentication and an explicit confirmation. Purging also removes related search data and tombstones embedded images with the article.

## Use AI to propose article edits or save a chat response
<!-- aliases: ai edit article | rewrite article with AI | expand article with chat | save chat as article -->
<!-- requires: article.write -->

When an article is attached to the AI chat, the assistant can propose focused replacements or a whole-article rewrite. Review the proposal card and accept it only after checking the diff. Applying safely fails if the article changed since the proposal or the original passage is missing or ambiguous.

To attach the active article, open the chat while viewing it; it is auto-attached. You can also type `@` in the chat input and choose an article. Any assistant response can be turned into a new article with **Save as article**; choose the title, folder, and format before creating it. The AI sees the attached article content, so do not attach customer data to an AI endpoint you are not authorized to use.
