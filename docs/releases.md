# Releases and deployment packages

Get official downloads from [GitHub Releases](https://github.com/mindscaper-org/audiocity/releases/latest).
Container images are published to [GitHub Container Registry](https://github.com/mindscaper-org/audiocity/pkgs/container/audiocity)
as `ghcr.io/mindscaper-org/audiocity:VERSION` and `:vVERSION`. Each version tag
supports Linux amd64 and arm64; Docker selects the matching architecture.
Deployment bundles pin an exact version. Version tags are not moved to newer releases.

Each release provides:

| Archive | Purpose |
|---|---|
| `audiocity-VERSION-deploy.tar.gz` | Compose file, deployment script, example configuration, license, and operator/client guides |
| `audiocity-VERSION-docker-amd64.tar.gz` | Docker image for Linux Intel/AMD 64-bit servers |
| `audiocity-VERSION-docker-arm64.tar.gz` | Docker image for Linux ARM64 servers, including Docker Desktop on Apple Silicon |
| `audiocity-VERSION-node.tar.gz` | Compiled JavaScript with a lockfile and source archive; install production dependencies using Node.js 26.5.0 and npm 12.0.1 |
| `audiocity-VERSION-source.tar.gz` | Complete source, tests, workflows, and build instructions |
| `SHA256SUMS` | SHA-256 checksums of all five archives |

The deployment bundle's `./deploy.sh` runs `docker compose up -d --wait`. Compose
pulls the pinned image from GHCR when it is missing and reuses an installed image.
Only Docker with Compose is required; public images need no registry login.
You can also run `docker compose pull` followed by `docker compose up -d --wait`
directly inside the deployment folder. The repository's root Compose file builds
from source instead.

Use a Linux Docker daemon. Docker Desktop runs Linux containers on macOS and
Windows; use a POSIX shell such as WSL on Windows, or run Compose manually.

Checksums can also be checked manually in the downloads directory:

```sh
sha256sum --ignore-missing -c SHA256SUMS
```

On macOS use `shasum -a 256 FILE` and compare with its entry in SHA256SUMS.
For offline installation, download the deployment bundle, the Docker archive for
your server's architecture, and `SHA256SUMS`. Verify the checksums, extract the
bundle, then load the image and start it from the extracted deployment folder:

```sh
docker load -i /path/to/audiocity-VERSION-docker-ARCH.tar.gz
docker compose up -d --wait --pull never
```

Replace `VERSION` and `ARCH` with the release version and `amd64` or `arm64`.
The archive includes both `ghcr.io/mindscaper-org/audiocity:VERSION` and the
compatibility tag `audiocity:VERSION`. Keep downloaded archives for offline
installs or rollback.

## Configure and upgrade

Copy `.env.example` to `.env` and edit it before the first start if needed. The
default port binds to loopback. Set the public origin and allowed editor origins,
and configure an HTTPS reverse proxy for a public deployment. See
[operations](operations.md) and [clients](clients.md).

The deployment bundle fixes the Compose project name to `audiocity`, so each
version reuses `audiocity_audiocity-data`. A source checkout started from a folder
named `audiocity` uses that same name by default. If migrating an existing install
with a different project name, set `COMPOSE_PROJECT_NAME=OLD_NAME` in your shell
before running deploy.sh and all other Compose commands, or migrate a
backup into the new volume before starting. Do not start two releases on the
same data volume.

Back up the stopped service before upgrading. Extract the new deployment bundle,
copy your existing `.env` into it, stop the old service, and run the new deploy.sh.
Keep the old bundle and backup. Roll back by stopping the new service and
restoring the backup into an empty volume using the previous release; do not
assume an older binary can read a newer database. `docker compose down` keeps
data, while `docker compose down -v` deletes it.

## Build packages locally

With the pinned Node.js and npm versions:

```sh
npm ci
npm run check
npm run package
npm run test:package
```

Archives and checksums are written to `dist/release/`. Source packaging uses an
explicit inventory and excludes `.env`, data, backups, dependencies, and local
Git history. The Node archive includes ready-to-run JavaScript and a matching
`dist/source.tar.gz`, served at `/source.tar.gz` for AGPL source availability.
It contains no platform-specific dependencies; `npm ci --omit=dev` installs
the locked dependencies on the target machine.

To export an image locally on its target architecture:

```sh
docker build -t audiocity:0.2.0 .
docker tag audiocity:0.2.0 ghcr.io/mindscaper-org/audiocity:0.2.0
docker save ghcr.io/mindscaper-org/audiocity:0.2.0 audiocity:0.2.0 | gzip > dist/release/audiocity-0.2.0-docker-amd64.tar.gz
cd dist/release
sha256sum *.tar.gz > SHA256SUMS
```

Use `docker-arm64` in the filename when building on ARM64.

## Publish a release

The `.github/workflows/release.yaml` workflow runs for pushed `v*` tags. It checks
that the tag matches `package.json`, runs TypeScript, lint, integration, browser,
and compiled package tests, and builds Docker images on native amd64 and arm64
runners. Both images are loaded from their exported archives and tested using
the actual deployment bundle, including authentication, audio ranges, block
sync, whole-file archive round trips, and source availability. Only after all
checks pass does the publishing job load and push those same tested images to
GHCR as `VERSION-amd64` and `VERSION-arm64`, combine them under the `VERSION` and
`vVERSION` tags, verify both platforms and anonymous pull access, and publish a
GitHub Release with all archives and checksums. The publishing job downloads
only release packages and Docker archives, excluding Buildx build records.

The workflow uses GitHub's built-in `GITHUB_TOKEN`. Only the publishing job gets
`contents: write` and `packages: write`; no separate registry credentials are
required. Images link to their source repository through OCI metadata.

### First GHCR publication

GitHub creates new container packages as private, even for public repositories.
After the first image upload, an organization/package administrator must open
the package's **Package settings → Change visibility** and select **Public**.
The workflow checks anonymous access before creating the GitHub Release. If the
first run stops at that check, make the package public and rerun failed jobs.
See [GitHub's package visibility instructions](https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility).

If organization policy restricts package creation, allow this repository to
publish container packages. For an existing package, ensure the repository has
write access under **Manage Actions access** in its package settings.

### Create a version tag

For the next release, update the version in `package.json` and the lockfile,
the service version in `src/app.ts`, `CHANGELOG.md`, and release notes in
`.github/release-notes.md`. Commit and push the release changes, then push the
matching tag:

```sh
git tag -a v0.2.0 -m 'Audiocity v0.2.0'
git push origin v0.2.0
```

Use the next version in place of `v0.2.0`. Published version tags and their
artifacts should remain immutable. No npm publishing credentials are required.
