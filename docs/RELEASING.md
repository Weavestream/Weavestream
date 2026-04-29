# Releasing Weavestream

Maintainer reference for cutting a release. Weavestream uses **SemVer
git tags** as the single source of truth for versions.

## When to bump what

- **PATCH** (`1.0.0 → 1.0.1`) — backwards-compatible bug fixes and
  internal refactors.
- **MINOR** (`1.0.0 → 1.1.0`) — backwards-compatible feature additions.
  New environment variables allowed if they have safe defaults.
- **MAJOR** (`1.0.0 → 2.0.0`) — breaking changes: removed endpoints,
  renamed env vars without a fallback, migrations that require manual
  ops steps.

Any release that requires an upgrade action from the operator must
call that out in `CHANGELOG.md` under the release's `### Upgrade notes`
subsection.

## Release checklist

1. **Start clean on `main`**

   ```bash
   git checkout main && git pull origin main
   pnpm install
   pnpm lint && pnpm typecheck && pnpm test
   ```

2. **Move `## Unreleased` → `## [X.Y.Z] - YYYY-MM-DD`** in
   [CHANGELOG.md](../CHANGELOG.md). Add a fresh empty `## Unreleased`
   section above it.

3. **Commit and open a PR titled `Release vX.Y.Z`.** Merge once CI is
   green.

4. **Tag the merge commit**

   ```bash
   git checkout main && git pull origin main
   git tag -a vX.Y.Z -m "Weavestream vX.Y.Z"
   git push origin vX.Y.Z
   ```

5. **Watch [`.github/workflows/release.yml`](../.github/workflows/release.yml).**
   It runs `docker buildx` for `api` / `web` / `worker` across
   `linux/amd64` + `linux/arm64` and pushes the following tags to GHCR:

   - `ghcr.io/weavestream/weavestream-<svc>:X.Y.Z`
   - `ghcr.io/weavestream/weavestream-<svc>:X.Y`
   - `ghcr.io/weavestream/weavestream-<svc>:X`
   - `ghcr.io/weavestream/weavestream-<svc>:latest`

6. **Verify the release**

   ```bash
   docker pull ghcr.io/weavestream/weavestream-api:X.Y.Z
   docker run --rm ghcr.io/weavestream/weavestream-api:X.Y.Z \
     node -e "console.log(process.env.WEAVESTREAM_VERSION)"
   # → X.Y.Z
   ```

7. **Announce.** The workflow auto-generates a GitHub Release with
   links to the images and the CHANGELOG. Post a short note in the
   [Discussions](https://github.com/Weavestream/Weavestream/discussions)
   "Announcements" category for anything user-visible.

## Manual build (workflow_dispatch)

For pre-release smoke testing, go to **Actions → Release → Run workflow**
and supply a `version` input (e.g. `rc-20260421`). This publishes
`ghcr.io/weavestream/weavestream-*:rc-20260421` without creating a git
tag or GitHub Release. Useful for validating the Dockerfiles on a PR
branch before merging.

## Yanking a bad release

If a published release is dangerous (data-loss bug, auth bypass, etc.):

1. Mark the GitHub Release as **draft** so it's hidden from the public
   releases page.
2. Add a `### Yanked` note to the CHANGELOG entry explaining the
   problem.
3. **Do not delete the image tag** — anyone who already pulled it
   would silently lose reproducibility. Push a new patch release (even
   if the fix is trivial) and tell users to upgrade.
4. If the issue is a security vulnerability, also publish a
   [GitHub Security Advisory](https://github.com/Weavestream/Weavestream/security/advisories).

## Versioning scope

The version string flows through three places:

1. **Git tag** (`vX.Y.Z`) — source of truth.
2. **Docker image tag + `WEAVESTREAM_VERSION` build arg** — baked into
   each image by the release workflow. Surfaces at runtime:
   - `apps/api` `/health/ready` response (authenticated; the public
     `/health` is liveness-only and does not leak the version)
   - `apps/web` login page footer (`NEXT_PUBLIC_APP_VERSION`)
3. **`CHANGELOG.md`** — the human-readable story.

There is intentionally no version in `package.json` beyond `0.0.0`; we
don't publish to npm and a single source of truth is safer than three
that drift.
