# App-help corpus

The Markdown files in `content/` are the release-matched product reference used by the AI chat tool. Keep each file focused on one feature and each `##` section focused on one task. A complete section is returned to the model, so it must make sense on its own.

Use this structure:

```markdown
# Feature title

## Task title
<!-- aliases: common wording | alternate name | abbreviation -->
<!-- requires: permission.name | another.permission -->

Complete, UI-focused instructions for the task.
```

- Use current labels and navigation from the Weavestream application.
- Put `###` headings inside a task when needed; they remain part of the parent section.
- Keep aliases short and specific. Retrieval is deterministic and uses titles, aliases, and body terms; it does not use embeddings.
- Permission names must exist in `src/rbac/permissions.ts`. They are explanatory and do not grant access.
- Do not add Docker, environment-variable, deployment, database, host, or server-administration instructions.
- Do not include secrets, customer data, tenant-specific state, or instructions that claim the chat tool performs a mutation.
- Keep each file below 64,000 bytes and each complete section below 6,000 characters.

The API refuses to start when the corpus is missing or malformed. A normal API build copies `content/**/*.md` into `dist/ai-help/content`; deploy that build for documentation edits to take effect.
