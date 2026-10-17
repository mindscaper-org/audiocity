# Release notes

## Unreleased

- Publish tested Linux amd64 and arm64 images to GitHub Container Registry under
  versioned multi-platform tags, using the release workflow's built-in token.
- Pull version-pinned GHCR images in deployment bundles while retaining verified
  image archives for offline installation.

## 0.2.0 — 2026-10-17

- Consolidate the browser library into Audio and Projects tabs, with one header
  upload action for mixed audio and AUP3/AUP4 files.
- Add dedicated playback and metadata pages with user-scoped slugs, editable
  tags and descriptions, administrator-managed categories, and ARR/CC licenses.
- Add spreadsheet-style metadata management with rectangular selection,
  quoted multiline TSV copy/paste, fill, undo and atomic batch saves.
- Decode WavPack audio in a browser worker using a bundled, reproducible
  WebAssembly runtime; include decoder source and third-party notices.
- Add optional read-only server-folder indexing and shared public uploads, with
  persistent per-user controls for inclusion in Audacity's lists and search.
- Automatically open the requested browser page after an authenticated Audacity
  handoff, with a styled fallback instead of an extra confirmation button.
- Play native project audio previews in the console library and revision history;
  detect uploaded mixdown formats and repair legacy MIME types at startup.
- Label previews from older revisions and offer preview generation in Audacity.
- Prevent Audacity 3's cached POST handles from corrupting subsequent Ctrl+S saves
  by closing POST response connections, while retaining strict JSON validation.
- Return stable numeric native project IDs so Windows Audacity 3 can reopen
  cloud projects after clearing its local cache, retaining legacy UUID routes.
- Fix manual account-linking tokens and authenticated browser destinations for
  Audacity 3's audio upload and cloud-project flows.
- Update deployment downloads and repository links after the move to
  `mindscaper-org/audiocity`.

## 0.1.0

Initial release of Audiocity, a self-hosted audio upload and project sync server.

- Audio uploads, sharing, playback and range downloads, with per-user quotas.
- Accounts, administrator console, OAuth with PKCE and password recovery.
- Audacity native block synchronization and byte-preserving AUP3/AUP4 archives.
- SQLite metadata and persistent local storage in a single unprivileged container.
- Prebuilt Docker images for Linux amd64 and arm64, a Compose deployment bundle,
  compiled Node.js package, complete source, and SHA-256 checksums.

Clients must be configured to use this server. Audacity desktop end-to-end testing
remains outstanding; protocol integration tests and browser workflows cover the
implemented behavior. Run one process against one local data volume. See the
client and operations guides for compatibility, HTTPS, backups, and recovery.
