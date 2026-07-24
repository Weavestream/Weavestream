# Contributing to Weavestream

Thanks for your interest in improving Weavestream. This guide covers the
fastest path from a clean clone to a reviewed PR.

## Licensing

Weavestream is released under the [GNU AGPL-3.0](LICENSE). By submitting
a pull request, you agree that your contributions are licensed under the
same terms.

Note: AGPL §13 means that anyone who runs a **modified** Weavestream as a
network-accessible service must offer their modified source to the users
of that service. If you fork Weavestream and deploy it publicly, plan
accordingly.

## Code of conduct

Participation in this project is governed by our
[Code of Conduct](CODE_OF_CONDUCT.md).

## Development setup

See [docs/DEVELOPING.md](docs/DEVELOPING.md) for the full contributor
quickstart (pnpm install, running tests, the `compose.build.yml`
override for building images locally, etc.).

Short version:

```bash
pnpm install
cp .env.example .env
./scripts/keygen.sh >> .env   # or scripts\keygen.ps1 on Windows
docker compose -f compose.yml -f compose.build.yml up -d --build postgres redis minio
pnpm prisma:migrate
pnpm dev
```

## Pull request checklist

Before opening a PR, please make sure:

- [ ] `pnpm lint` passes.
- [ ] `pnpm typecheck` passes.
- [ ] `pnpm test` passes (or you've added tests covering the new behavior).
      The company PDF export specs need the Poppler and libxml2 CLIs:
      `apt-get install poppler-utils libxml2-utils`, or on macOS
      `brew install poppler`. They skip with an install hint when those
      are missing, so install them before touching the PDF exporter —
      CI requires them.
- [ ] `pnpm install --frozen-lockfile` passes (if you changed any `package.json`, commit the updated `pnpm-lock.yaml`).
- [ ] If you added or changed environment variables, the docs are in sync.
      A new **required** variable goes in both `.env.example` and
      [docs/configuration/environment.md](docs/configuration/environment.md);
      a new **optional** variable (one with a safe default in
      `packages/shared/src/env.ts`) goes in
      [docs/configuration/environment.md](docs/configuration/environment.md)
      only — add it to the commented "Optional tuning" block in `.env.example`
      just for the handful that are commonly tuned.
- [ ] If you added a new Prisma migration, it's included and CI's
      `prisma-migrate-dry-run` job is green.
- [ ] The PR description explains **why** the change is needed, not only
      what it does.

## Commit style

We don't enforce a strict convention, but prefer short, imperative-mood
subject lines (72 chars or less) with a body explaining context when the
change isn't self-evident:

```
Tighten auth rate-limit response headers

Returning Retry-After on 429 lets well-behaved clients back off without
guessing. Closes #123.
```

## Releases

End-users pull tagged images from GHCR. The full release process — git
tag → GitHub Actions → GHCR multi-arch image — is documented in
[docs/RELEASING.md](docs/RELEASING.md). Maintainers only.

## Questions

Open a [GitHub Discussion](https://github.com/Weavestream/Weavestream/discussions)
for design questions or a [Bug report](https://github.com/Weavestream/Weavestream/issues/new/choose)
for anything reproducible. Security issues go through [SECURITY.md](SECURITY.md).
