---
label: Releasing
icon: tag
order: 100
description: Maintainer reference for cutting and verifying Weavestream releases.
---

# Releasing

This page is for maintainers cutting a Weavestream release. Weavestream uses **SemVer git tags** as the source of truth for versions.

## When To Bump What

- **PATCH** (`1.0.0` -> `1.0.1`) - backwards-compatible bug fixes and internal refactors.
- **MINOR** (`1.0.0` -> `1.1.0`) - backwards-compatible feature additions. New environment variables are allowed when they have safe defaults.
- **MAJOR** (`1.0.0` -> `2.0.0`) - breaking changes such as removed endpoints, renamed environment variables without fallback, or migrations requiring manual operator steps.

Any release that requires an operator action must call it out in `CHANGELOG.md` under the release's `### Upgrade notes` subsection.

## Release Checklist

1. Start clean on `main`:

```bash
git checkout main
git pull origin main
pnpm install
pnpm lint && pnpm typecheck && pnpm test
```

2. Move `## Unreleased` to `## [X.Y.Z] - YYYY-MM-DD` in [CHANGELOG.md](https://github.com/Weavestream/Weavestream/blob/main/CHANGELOG.md). Add a fresh empty `## Unreleased` section above it.

3. Commit and open a PR titled `Release vX.Y.Z`. Merge once CI is green.

4. Tag the merge commit:

```bash
git checkout main
git pull origin main
git tag -a vX.Y.Z -m "Weavestream vX.Y.Z"
git push origin vX.Y.Z
```

5. Watch [`.github/workflows/release.yml`](https://github.com/Weavestream/Weavestream/blob/main/.github/workflows/release.yml). It runs Docker Buildx for `api`, `web`, and `worker` across `linux/amd64` and `linux/arm64`, then pushes these tags to GHCR:

- `ghcr.io/weavestream/weavestream-<svc>:X.Y.Z`
- `ghcr.io/weavestream/weavestream-<svc>:X.Y`
- `ghcr.io/weavestream/weavestream-<svc>:X`
- `ghcr.io/weavestream/weavestream-<svc>:latest`

6. Verify the release:

```bash
docker pull ghcr.io/weavestream/weavestream-api:X.Y.Z
docker run --rm ghcr.io/weavestream/weavestream-api:X.Y.Z \
  node -e "console.log(process.env.WEAVESTREAM_VERSION)"
```

7. Announce. The workflow auto-generates a GitHub Release with links to the images and changelog. Post a short note in the [Discussions](https://github.com/Weavestream/Weavestream/discussions) announcements category for user-visible changes.

## Manual Build

For pre-release smoke testing, go to **Actions -> Release -> Run workflow** and supply a `version` input such as `rc-20260421`.

This publishes `ghcr.io/weavestream/weavestream-*:rc-20260421` without creating a git tag or GitHub Release. Use it to validate Dockerfiles on a PR branch before merging.

## Yanking A Bad Release

If a published release is dangerous, for example a data-loss bug or auth bypass:

1. Mark the GitHub Release as **draft** so it is hidden from the public releases page.
2. Add a `### Yanked` note to the changelog entry explaining the problem.
3. Do not delete the image tag. Anyone who already pulled it would silently lose reproducibility.
4. Push a new patch release and tell users to upgrade.
5. If the issue is a security vulnerability, publish a [GitHub Security Advisory](https://github.com/Weavestream/Weavestream/security/advisories).

## Versioning Scope

The version string flows through three places:

1. **Git tag** (`vX.Y.Z`) - source of truth.
2. **Docker image tag and `WEAVESTREAM_VERSION` build arg** - baked into each image by the release workflow. It surfaces in authenticated readiness output and the web login page footer.
3. **`CHANGELOG.md`** - the human-readable release notes.

There is intentionally no application version in `package.json`; the project does not publish npm packages, and one version source is safer than several that can drift.
