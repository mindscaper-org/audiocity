Audiocity 0.2.0 adds a unified audio/project library, client-side WavPack playback, metadata management and a shared sound library, alongside fixes for Windows Audacity 3 cloud synchronization.

### What's new

- **One library:** Audio and Projects tabs, with **+ Upload** accepting audio and AUP3/AUP4 files together.
- **Browser playback:** WavPack decoding runs locally in a worker. Dedicated audio pages support readable share links and associated metadata editors.
- **Metadata:** Administrator-managed categories, user tags and descriptions, slugs, All rights reserved, CC0 and all six Creative Commons 4.0 license types.
- **Manage files:** Spreadsheet selection, quoted multiline TSV copy/paste, fill, undo and transactional saves for audio metadata.
- **Shared library:** Index an existing read-only server directory and include public uploads. Each account can hide shared recordings from Audacity's lists and search.
- **Project previews:** Play Audacity-generated mixdowns in the library and revision history, with older previews clearly labeled.
- **Audacity 3 fixes:** Reliable cold project reopen, repeated Ctrl+S saves, account linking and automatic browser handoffs. Tested manually with Windows Audacity 3.7.9 against a WSL-hosted server.

### Download and deploy

1. Download and extract the **deploy.tar.gz** bundle below.
2. Install Docker with Compose, then run **`./deploy.sh`** inside the extracted folder. Docker pulls the pinned image from **`ghcr.io/mindscaper-org/audiocity`**, selects Linux amd64 or arm64 for your server, and starts Audiocity. No registry login is needed.
3. Open **http://localhost:8080**. Run `docker compose logs audiocity` to retrieve the generated first-run administrator password, then change it after signing in.

Copy `.env.example` to `.env` before starting to customize the URL, administrator, quotas, or allowed editor origins. Use an HTTPS reverse proxy for a public deployment. Data persists in a Docker volume; back up before upgrades.

For an existing installation, preserve its `.env`, Compose project name and data volume. Back up before upgrading: this release adds shared-library metadata and categories to SQLite. Shared server files remain in place and need their own backup. Set `AUDIOCITY_SHARED_DIR` to a directory mounted inside the container; see `docs/library-api.md` for a read-only mount example.

### Other packages

- **docker-amd64.tar.gz / docker-arm64.tar.gz**: prebuilt Linux images for offline installation. Verify the checksum, run `docker load -i FILE`, then run `docker compose up -d --wait --pull never` inside the deployment bundle.
- **node.tar.gz**: compiled JavaScript; requires Node.js 26.5.0 and npm 12.0.1. Extract, run `npm ci --omit=dev`, then follow the included README.
- **source.tar.gz**: full corresponding source and build instructions (AGPL-3.0-only). Running deployments also serve it at `/source.tar.gz`.
- **SHA256SUMS**: verify downloaded archives using `sha256sum --ignore-missing -c SHA256SUMS`, or `shasum -a 256 FILE` and compare with the matching entry.

Clients must be configured to use Audiocity; see the included `docs/clients.md`. Other editor versions still require validation. WavPack playback supports up to 64 MiB encoded / 128 MiB decoded audio; larger originals remain downloadable. Run one server process against one local data volume. The included operations guide covers HTTPS, backup, password recovery, and upgrades.
