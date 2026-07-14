# Assets

## Create, edit, and find assets
<!-- aliases: new asset | add asset | create server | add device | asset inventory | edit asset | find asset -->
<!-- requires: asset.write | asset.read -->

Assets are company-scoped records created from global asset layouts. Open a company, choose **Assets**, then select **New asset**. Pick a layout, complete its required fields, and select **Create asset**. A value for a field marked **Unique per company** cannot duplicate another asset using that layout in the same company.

To edit an asset, open it and select **Edit**. Layout fields control the form; changing an asset never changes the layout definition. The assets browser supports search, layout selection, table sorting, archived-state display, tag filtering, and fields configured as filters. The command palette can also find accessible assets across companies.

If an imported field is controlled by an integration, a later successful sync can overwrite a manually entered value when its mapping is source-controlled. A mapping configured to preserve manual values leaves an operator’s existing value intact.

## Use tags, references, files, and rich links on an asset
<!-- aliases: asset tags | attach file to asset | related asset | linked items | embed asset link | add password to asset | rich text links -->
<!-- requires: asset.write | relation.write | upload.create -->

Use a **Tags** layout field to apply flexible global labels, such as `production`, `network`, or `needs-review`. Tags can be created while editing an asset; global tag rename/delete is an Admin capability. Tags also connect the asset browser with password records carrying the same tag.

Use an **Asset** reference field to link one asset to another in the same company. The field can target one or many assets and creates a relation that appears in each record’s **Linked items** panel. For ad-hoc links between an asset, article, or password, open **Linked items**, select **Add link**, search within the company, and select the target. Links are bidirectional: either item displays the relationship. Removing a link removes that relation, not either record.

Use a **File** field to attach manuals, diagrams, certificates, configuration exports, or photos to the asset. The field’s layout settings determine accepted types, maximum size, and whether multiple files are allowed. File access remains company-authorized.

A **Rich text** asset field supports formatted content and embedded mentions. Type `@` while editing rich text, choose an asset, article, or password from the company, and save. The mention renders as an in-app link. It does not bypass authorization: a viewer must still be allowed to read the linked record.

## Attach and use passwords on an asset
<!-- aliases: embedded password | asset credential | attach credential to device | credentials on asset | password on server -->
<!-- requires: password.write | password.read -->

An asset detail page can show a **Credentials** panel. Use its add action to create a password already attached to that asset, or open an existing password and use **Linked items → Add link** to associate it with the asset. An embedded/linked password remains a separate encrypted password record with its own access restrictions, reveal audit events, version history, and client-visibility setting.

If the asset is archived, passwords embedded directly on it are soft-archived too. A regular relation link does not imply that the password’s visibility or reveal permission is inherited from the asset. Users must satisfy password authorization separately.

## Archive, restore, or permanently delete an asset
<!-- aliases: remove asset | delete asset | archive device | restore asset | purge asset | bulk archive assets -->
<!-- requires: asset.archive | asset.purge -->

Use the asset actions menu to **Archive** an asset. Archiving removes it from normal active lists while retaining its fields, relations, history, and audit trail. Turn on **Show archived** in the assets browser to locate archived assets and choose **Restore**.

**Permanently delete** is irreversible. It is offered only after an asset has been archived and requires fresh step-up authentication plus a confirmation. The browser also supports bulk archive, restore, and permanent deletion; a bulk purge skips assets that are still active, so archive those first and retry.

Purging removes the asset and dependent asset values, relations, integration links, and search entry. If an external integration still provides the record, a later sync can recreate it or claim a matching asset; change the integration mapping or disable the resource when the external record should no longer be managed.
