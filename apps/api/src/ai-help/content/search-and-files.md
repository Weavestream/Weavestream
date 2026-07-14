# Search, files, tags, and linked items

## Search records across accessible companies
<!-- aliases: search | command palette | find article | find password | find asset | global search | Ctrl K | Cmd K -->
<!-- requires: asset.read | article.read | password.read | domain.read | upload.read -->

Press **Cmd+K** on macOS or **Ctrl+K** on Windows/Linux to open the command palette. Start typing to search accessible assets, articles, passwords, files, domains, and companies. Select a result to open the corresponding record.

Search is permission- and company-scoped. It does not expose records from companies you cannot access, excludes normal archived results unless you request archived content, and honors client portal field visibility. Titles and primary labels are strong search terms, so use specific asset names and article titles. Rich text is indexed as plaintext; searching finds its text but not formatting.

From your user profile, choose whether the palette searches the current company only or all accessible companies, and whether to prefer recent items or comprehensive search. The palette is a finder, not a mutation tool.

## Upload files and use the photo gallery
<!-- aliases: upload file | attach file | image gallery | photos | add image | download upload | company logo -->
<!-- requires: upload.create | upload.read -->

Upload files from supported attachment controls, including asset File fields, password attachments, article images, and company-logo controls. Supported categories include images; PDFs, Office documents, email messages, archives/installers, text/scripts, and common configuration/data files. The configured upload size and allowed types can differ by deployment and by File layout field.

Open a company’s **Photos** area to browse uploaded images as a gallery and select one for its full-size view. Images receive thumbnails automatically. Files are read through authorized app routes, so sharing an internal file URL is not a substitute for granting someone company access.

For an asset, use its File field for structured technical attachments. For a password, use **Attachments** for credential-adjacent material. For an article, use the image picker when the image should render inside the document. Attach an image to a record rather than embedding an external image URL if the image must remain inside the company’s authorized storage.

## Create, manage, and use global tags
<!-- aliases: add tag | asset tag | password tag | tag filter | rename tag | delete tag -->
<!-- requires: tag.manage.global -->

Tags are global reusable labels available in Asset **Tags** fields and password forms. While editing an asset or password, type to select an existing tag or create a new one inline. Use tags for classifications that cross layouts and folders, such as `production`, `network`, `renewal`, or a customer-specific workflow marker.

Use tag filters in the assets browser to narrow records. Tags also surface related password records carrying the same tag, which is useful for moving between a system and its credentials. Open **Admin → Tags** to rename or delete a global tag. Renaming updates its displayed label wherever it is used; deleting removes the chip association. Use a layout Dropdown for a constrained, schema-level value and Tags for flexible multi-record grouping.

## Link records without copying sensitive data
<!-- aliases: linked items | add link | related records | cross link article asset password | bidirectional links -->
<!-- requires: relation.write | relation.read -->

Assets, articles, and passwords have a **Linked items** panel. Open it, select **Add link**, search for an asset/article/password in the same company, and select the item. The relation is bidirectional, grouped by record type, and removable from either endpoint.

Use linked items for associations such as an asset ↔ its runbook, asset ↔ its credential, or article ↔ a related service. A linked record does not inherit permissions, client visibility, or password reveal rights from the other record. This makes links safer than copying a credential into an article or note.

An Asset reference layout field also creates a linked-item relation, but it additionally enforces a chosen target layout and can support one or multiple selections. Choose the reference field for a structured relationship that belongs on every asset form; choose Linked items for an ad-hoc relationship.
