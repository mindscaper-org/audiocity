# Audiocity

Self-hosted audio uploads and Audacity project synchronization in one Docker container. SQLite holds account and revision metadata; a persistent data volume holds original audio, project snapshots, and audio blocks. No external database, object store, email service, or audio.com account is required.

Implemented:

- Accounts, administrator-created users, optional registration, OAuth authorization codes with PKCE, access/refresh tokens, and password recovery.
- Original sound uploads: WAV, MP3, FLAC, WavPack, AIFF, Ogg, and M4A, with private, unlisted, or public visibility and HTTP range playback/downloads.
- Audacity's native cloud snapshot/block protocol, missing-block reuse, resumable transfers, revisions, conflict detection, and history.
- Complete AUP3/AUP4 file revisions for clients such as Soundscaper, preserving the uploaded SQLite file byte for byte.
- One library with Audio and Projects tabs, a header **+ Upload** action for audio and AUP3/AUP4 files, and dedicated audio playback and metadata pages.
- Client-side WavPack playback, including Audacity's lossless uploads. Originals stay unchanged; the browser loads its decoder only when needed.
- A shared browser library combining a configured server directory with public uploads, with a persistent per-user default for including shared files. Native Audacity lists retain owned uploads.
- Administrator-managed categories, tags, descriptions, slugs, licenses, and a spreadsheet-style **Manage files** page for bulk metadata editing. See the [library guide](docs/library.md).
- Native project audio previews and project archive downloads. Audacity's **Update Cloud Audio Preview** supplies native project previews; older previews are labeled when a later save has no mixdown.

Compatibility is tested against the observed protocol, with manual Windows Audacity 3.7.9 testing against a WSL-hosted server for login, audio upload, cloud project save/reopen, and preview generation. Other editor versions still require validation. Clients must be configured to use Audiocity: [Audacity 3 setup](docs/clients.md#audacity-3-select-your-server-in-audacitycfg) uses `audacity.cfg`; Audacity 4 currently hardcodes its cloud server and requires a custom build, [Soundscaper](https://soundscaper.org) has a preference in Edit→Preferences→Advanced. Whole-file archive storage and Audacity's native block transport are separate, explicitly identified formats. See [client setup](docs/clients.md) and [protocol details](docs/project-protocol.md).

## Start

Install Docker with Compose v2 or newer, then:

1. Download and extract `audiocity-VERSION-deploy.tar.gz` from the [latest release](https://github.com/mindscaper-org/audiocity/releases/latest).
2. Open a terminal in the extracted folder and run:

```sh
./deploy.sh
docker compose logs audiocity
```

The script downloads the prebuilt Linux image for your Docker server (amd64 or arm64), checks its SHA-256 checksum, and starts the service. No registry account or build tools are needed. The bundle includes `.env.example`, client setup, and operations documentation. For offline deployment, download the matching Docker image archive from the same release, run `docker load -i FILE`, then `docker compose up -d --wait` inside the deployment folder. A compiled Node.js package and full source archive are also available; see [release packaging](docs/releases.md).

To build from a source checkout instead:

```sh
git clone https://github.com/mindscaper-org/audiocity.git
cd audiocity
docker compose up --build -d
docker compose logs audiocity
```

Open <http://localhost:8080>. The first startup creates `admin@audiocity.local` and prints a randomly generated password once. Save it, sign in, and use **Menu → Change password**. Alternatively, set `AUDIOCITY_ADMIN_EMAIL` and a password of at least 12 characters in `.env` before the first startup. Existing accounts are not reset when these environment variables change.

The default Compose port binds to loopback. Data is retained in the `audiocity-data` named volume across container rebuilds and restarts. `docker compose down` retains it; `docker compose down -v` deletes it.

Without Compose:

```sh
docker build -t audiocity:local .
docker run -d --name audiocity --init --restart unless-stopped \
  -p 127.0.0.1:8080:8080 -v audiocity-data:/data audiocity:local
docker logs audiocity
```

## Configure

Copy `.env.example` to `.env` to override defaults. Recreate the container after configuration changes.

| Variable | Default / purpose |
|---|---|
| `AUDIOCITY_PUBLIC_URL` | `http://localhost:8080`; externally reachable origin, no path prefix |
| `AUDIOCITY_CORS_ORIGINS` | `http://localhost:8080`; comma-separated allowed editor origins |
| `AUDIOCITY_ADMIN_EMAIL` | `admin@audiocity.local`; initial administrator only |
| `AUDIOCITY_ADMIN_PASSWORD` | Generated once when blank; initial administrator only |
| `AUDIOCITY_REGISTRATION` | `false`; administrator can create accounts through the console |
| `AUDIOCITY_MAX_UPLOAD_BYTES` | 1 GiB per transfer |
| `AUDIOCITY_MAX_USER_BYTES` | 20 GiB per account, including retained revisions |
| `AUDIOCITY_SHARED_DIR` | Optional server directory of shared audio; mount it into the container and use its container path |
| `AUDIOCITY_AUDACITY_CLIENT_ID` | `audiocity-desktop`; configure the same value in Audacity |
| `AUDIOCITY_AUDACITY_CLIENT_SECRET` | `audiocity-local-desktop`; local compatibility client credential |
| `AUDIOCITY_BIND_ADDRESS` | `127.0.0.1`; Compose port binding |
| `AUDIOCITY_PORT` | `8080`; host port in Compose, listen port outside Docker |

Native Node runs additionally accept `AUDIOCITY_DATA_DIR` (default `./data`), `AUDIOCITY_HOST`, `AUDIOCITY_TOKEN_TTL_SECONDS` (3600), and `AUDIOCITY_UPLOAD_TTL_SECONDS` (86400). Compose intentionally keeps the internal port at 8080. If the host port changes, update `AUDIOCITY_PUBLIC_URL` and allowed origins too.

For another machine or a public deployment, set the public HTTPS URL and place a TLS reverse proxy in front of the loopback port. Keep the proxy's upload limit and request timeout large enough for your configured transfers; use HTTP/1.1 streaming and avoid buffering entire uploads. Set `AUDIOCITY_CORS_ORIGINS` to the actual Soundscaper/editor origin as well as the console origin. Credentials must travel over HTTPS outside a local machine. No live service requests are sent to audio.com.

## API

- [Audio uploads, listing, editing, sharing and downloads](docs/audio-api.md)
- [Library, uploads, playback, metadata and bulk editing](docs/library.md)
- [Project snapshots, whole-file archives, revisions, and resuming uploads](docs/project-protocol.md)
- [Authentication, scopes, OAuth clients and password changes](docs/authentication.md)
- [audio.com API compatibility and deliberate extensions](docs/audio-com-compatibility.md)
- [Audacity and Soundscaper client configuration](docs/clients.md)
- [Operations, recovery and backups](docs/operations.md)

`GET /health` checks service/database availability. `GET /.well-known/audiocity` advertises supported features and transfer limits; `GET /.well-known/oauth-authorization-server` advertises OAuth endpoints. Errors use `{ "status": 422, "name": "ValidationError", "message": "…" }`.

## Development and verification

Use Node.js **26.5.0** and npm **12.0.1**:

```sh
npm ci
npm run check
npm run build
npm run dev
```

`npm run check` runs strict TypeScript, type-aware ESLint, and the Node integration suite. Tests exercise auth, the Audacity DTO shapes, upload completion, cross-account isolation, conflicts, deduplication, archive persistence, streaming ranges, and transfer validation. Tests use temporary data directories and do not contact audio.com. `npm run build` produces `dist/`; the Docker image builds and runs that JavaScript as an unprivileged user.

The browser suite starts its own loopback server with disposable storage and runs the console workflows in headless Chromium:

```sh
npx playwright install chromium
npm run test:browser
```

Set `PLAYWRIGHT_PORT` if the default test port is in use.

For a running local or Docker server, use a disposable account to exercise the actual HTTP path:

```sh
AUDIOCITY_SMOKE_PASSWORD='your-password' npm run test:smoke
```

Set `AUDIOCITY_URL` and `AUDIOCITY_SMOKE_EMAIL` if needed. This creates and deletes test audio and projects. The native block fixtures are opaque test bytes, and archive fixtures test byte-preserving transport; they do not demonstrate that a desktop editor can open the fixtures.

## Scope

Audiocity implements storage, playback, metadata and project synchronization; audio.com's social, subscription, collection and statistics features are outside its scope. Audio stays in its original format. WavPack playback uses a browser-side decoder; other formats use the browser's available codecs. The server does not transcode, interpret native block audio, convert project generations, merge concurrent edits, or reconstruct whole project files from native block snapshots. Editors remain responsible for those operations.

Run one server process against one local data volume. Multi-replica operation, remote/network filesystems, and shared SQLite volumes are unsupported. See the operations guide for backup and cleanup behavior.

Licensed under [AGPL-3.0-only](LICENSE). See [notices](NOTICE.md). Built deployments serve their corresponding source at `/source.tar.gz`; the archive excludes local credentials and stored user data.
