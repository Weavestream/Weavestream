# Assets

## Create an asset
<!-- aliases: new asset | add asset | create server | add device | create equipment record -->
<!-- requires: asset.write -->

Assets belong to a company and use a global asset layout as their field template.

1. Open the company that should own the asset.
2. Open **Assets** and select **New asset**.
3. On **Pick a layout**, choose the template that describes the asset.
4. Complete the fields supplied by that layout. Required fields must be filled, and fields marked unique cannot reuse a value already present in that company.
5. Select **Create asset**.

Weavestream opens the new asset after saving it. If no layout is available, a user with the global layout-management capability must create or restore one first.

## Edit an asset
<!-- aliases: change asset | update asset | modify device | edit server details -->
<!-- requires: asset.write -->

1. Open the company and select the asset.
2. Select **Edit** from the asset detail page.
3. Change the asset name or any layout-defined field.
4. Select **Save asset**.

Fields marked as integration-synced show their source. Manual changes to a source-controlled field may be replaced by the next successful sync; fields configured to preserve manual values are left unchanged.

## Archive or permanently delete an asset
<!-- aliases: remove asset | delete asset | archive device | purge asset -->
<!-- requires: asset.archive | asset.purge -->

Archiving removes an asset from active lists while retaining its history. Use the asset actions to archive it; archived assets can later be restored.

Permanent deletion is a separate, irreversible action. The asset must already be archived, the user must have purge access, and Weavestream requires fresh step-up authentication. If an integration still represents the external record, a later sync may create or match another asset unless the integration mapping is changed.

