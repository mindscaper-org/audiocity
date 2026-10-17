# Library API and shared directories

The browser library combines uploaded audio and Audacity project archives. Audio metadata is available through `GET /library/audio`, with `source=mine|shared|all`, `q`, `sort=newest|oldest|az`, `page`, and `per-page` (1–100). Results contain `items` and `pagination`. Shared audio includes ready public uploads and files indexed from the optional server directory. Private and unlisted uploads remain out of other users' shared lists.

Each item includes `title`, `slug`, `category`, `description`, `tags` (string array), `license`, `visibility`, `is_downloadable`, `origin`, `can_edit`, `playback_path`, and a signed `play.url`. Download capabilities expire after one hour and support byte ranges. `GET /library/audio/:id` returns a readable item. Private uploads require their owner; folder files require a signed-in account. Public and unlisted ready uploads can be viewed anonymously. `GET /library/audio/resolve?username=NAME&slug=SLUG` resolves a user-scoped slug with the same access rules. Existing `/public/audio/:id` JSON endpoints remain available.

Owners can `PATCH /library/audio/:id`. Administrators can edit folder entries' metadata; other users cannot. The body accepts `title` (256 characters), `slug` (100 lowercase letters/numbers/hyphens), `category` (configured category ID), `description` (500 characters), `tags` (up to 50 strings, each 64 characters), `license`, `visibility` (`private`, `unlisted`, `public`), and `is_downloadable` (boolean). Folder entries have fixed shared visibility and are downloadable by all signed-in users; their original filenames and bytes are unchanged.

`PATCH /library/audio/batch` accepts `{ "items": [{ "id": "…", "title": "…" }] }` with 1–1000 unique IDs. Authorization, validation, and slug uniqueness apply to every item. All edits succeed together or none do, and swapping two files' slugs is supported.

`GET /library/options` is public and returns `categories`, `licenses`, and `shared_folder`. Categories are managed by administrators through `GET/POST /admin/categories` and `PATCH/DELETE /admin/categories/:id`. Creating a category takes `{ "id": "field-recording", "name": "Field recording" }`; renaming takes `{ "name": "…" }`. IDs remain stable. Categories in use and the fallback `other` category cannot be deleted. Defaults are seeded only on initial migration. Legacy category IDs `voice-over` and `sound-design` are accepted as aliases for `voiceover` and `sfx`.

Licenses are `none` (No license selected), `arr` (All rights reserved), `cc-0` (CC0 1.0), and the six Creative Commons 4.0 licenses: `cc-by`, `cc-by-sa`, `cc-by-nc`, `cc-by-nc-sa`, `cc-by-nd`, and `cc-by-nc-nd`. An explicit `none` value is preserved through edits and restarts. API uploads default to `none`; browser uploads explicitly select `arr`.

`GET/PATCH /library/preferences` reads or changes `{ "include_shared": true }` for the signed-in user. It defaults to true. Turning it off hides shared audio from default browser and native Audacity lists/search, while explicit browser `source=shared` and existing playback links still work.

## Configure an existing shared folder

Set `AUDIOCITY_SHARED_DIR` to an existing absolute directory containing WAV, MP3, FLAC, WavPack, AIFF, Ogg/Opus, M4A/MP4, AAC, or WebM audio. Audiocity indexes supported files recursively and never copies, modifies, or removes originals. Symlinks and unsupported containers are excluded. The configured path itself must have no symlink components. Metadata edits are stored in Audiocity's database and survive rescans and restarts.

For Docker Compose, use a local override such as `compose.shared.yaml`:

```yaml
services:
  audiocity:
    environment:
      AUDIOCITY_SHARED_DIR: /shared
    volumes:
      - /absolute/host/sfx:/shared:ro
```

Run `docker compose -f compose.yaml -f compose.shared.yaml up -d --build`. Do not set the path to a directory containing material that should remain private: every signed-in account can read indexed audio. Public uploads join the shared library logically; they are still stored in Audiocity's data volume and are not written into the configured directory.

The folder is scanned at startup and when a library or native audio list/search is requested, at most once every 30 seconds. An administrator can force a scan with `POST /admin/shared/rescan`; the response is `{ "files": 123 }`. Removing or replacing an original makes old download capabilities unavailable. Rescanning preserves metadata for stable relative paths and revokes capabilities when file size or modification time changes.
