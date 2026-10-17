# Audio uploads

Audiocity preserves uploaded originals on the persistent data volume. It does not
transcode, normalize, or render waveforms. Playback uses the original source and
HTTP byte ranges. WAV duration is extracted when a normal RIFF `fmt`/`data` layout
is present; duration is otherwise zero in the server metadata. Playback pages
decode WavPack in a browser worker using the bundled WebAssembly decoder; their
player obtains the decoded duration. Other formats depend on native browser
codec support. See the [library guide](library.md).

## Upload an original

Send a bearer token with audio access to `POST /v1/audio/create`:

```json
{
  "name": "Rain.wav",
  "mime": "audio/wav",
  "size": 48044,
  "category": "recording",
  "title": "Evening rain",
  "visibility": "private"
}
```

The public API requires `mime`, `size` and `category`. The `201` response contains `audio` metadata and capability URLs `url`, `success`,
`fail`, and `progress`. `id` identifies the binary transfer; `audio.id` identifies
the audio resource. PUT the original bytes to `url` and then POST `success` (GET
is also accepted). Sending DELETE to `fail` cancels an unfinished upload. These
URLs include authorization secrets and must be treated as credentials. The
registered size must match the transferred size. A container signature check
rejects bytes inconsistent with the declared MIME type; this is not full media
decoding or a guarantee that the recording can play.

MIME families: WAV, MP3, FLAC, WavPack, AIFF, Ogg, and M4A/MP4, including audio.com
aliases. Maximum source size and per-user disk quota are configured by the server.
An uploaded recording remains `pending` and has an empty `play.url` until the
success callback confirms it. Failed or incomplete uploads cannot be shared.

## Library operations

All `/v1/audio/*` operations require a bearer token with audio access and act only
on the authenticated user's recordings. Native `/my/audio` listings also contain
only that user's uploads. Browse shared recordings through the explicit browser
library API. IDs may be UUIDs or
`slug:your-audio-slug` for the owner's library; folder recordings use stable
`shared-…` IDs. The console uses the explicit [library API](library-api.md) for
source selection, categories, preferences and transactional metadata batches.

| Method and path | Behavior |
| --- | --- |
| `GET /v1/audio/list` | Array of owned recordings, including pending uploads |
| `GET /v1/audio/view?id=…` | Metadata for an owned recording |
| `PATCH /v1/audio/update?id=…` | Edit title, slug, category, description, tags, license, visibility, or download permission |
| `POST /v1/audio/delete?id=…` | Delete owned metadata and source bytes; returns `204` |

Listing accepts `page` and `per-page` (1–100, default 50), `sort=newest`, `oldest`, or `az`, and
`q` for a title substring. Audio metadata includes `play.url` for ready uploads;
this is a temporary signed URL supporting `Range` requests. Refresh metadata when
a playback URL expires.

Title and name are limited to 256 characters, description to 500, and tags to 50
strings of at most 64 characters. Slugs use lowercase letters, digits and hyphens
and are unique within one user's library. Automatic slugs receive numeric suffixes
when needed. Categories are persisted and controlled by administrators. The public
API uses the standard `voice-over` and `sound-design` category IDs; the browser
library stores those as `voiceover` and `sfx`. Custom browser categories are
reported as `other` by the public API.
Licenses include no license selected (`none`, the API default), All rights reserved
(`arr`), CC0 and the six Creative Commons 4.0 licenses. The console explicitly
selects All rights reserved for new browser uploads.

## Search public recordings

`GET /v1/search?query=rain&types=audio&page=1` requires a bearer token with audio
access and returns an array of `{ "type": "audio", "model": AUDIO_METADATA }`
objects. It searches ready, public recordings across all accounts. Private,
unlisted, pending and cancelled recordings never appear, including the caller's
own recordings. Use `/v1/audio/list` for the owner's complete library.

Queries match literal substrings in titles, descriptions, tags and display names,
with SQLite's case-insensitive matching for ASCII characters. A query beginning
with `#` matches an exact tag. Empty queries browse all public recordings. Results
are newest first in fixed pages of ten; `page` is between 1 and 999999 and `query`
is at most 256 characters. Search is limited to 60 requests per minute per account.
The `types` filter accepts audio.com's `audio`, `author` and `collection` names,
comma-separated; this server only implements audio results. Unlike audio.com,
it does not rank results by relevance or return author and collection results.

## Sharing

New API uploads default to unlisted, matching audio.com's documented
`is_listed: false` default. Audiocity's own console explicitly selects private
sharing by default. The additional `visibility` field can select:

- `private`: owner access only; excluded from public metadata and discovery.
- `unlisted`: anyone with the resource URL can listen; excluded from discovery.
- `public`: anyone can listen; included in `GET /public/audio` discovery.

For audio.com compatibility, `is_listed: true` means public, and
`is_listed: false` or omitting the field means unlisted. Explicit `visibility`
takes precedence if both occur. Private sharing is an Audiocity extension;
audio.com does not offer private audio. This default change does not alter any
existing recording's sharing setting.

`GET /public/audio/:id` returns metadata only for ready, shared recordings.
`GET /audio/:id` also lets the authenticated owner read private metadata. Public
metadata contains the author's display name, username and user ID, without email,
account permissions or authentication details.

`GET /download/:id` returns an `items` array with the original file's `format`,
`url`, `size` and `source: true`. The owner can always obtain a ready original.
Other listeners require explicit `is_downloadable: true`. Listening still gives
access to the source bytes: download permission controls the download API, rather
than preventing a listener from saving media they can play. Previously issued
signed media URLs remain valid for up to an hour after changing visibility;
deleting the audio immediately makes those URLs unavailable.

## Audacity protocol compatibility

`POST /audio` accepts Audacity's `name`, `mime`, `size`, `public`, and `method`
fields. Its response additionally supplies `extra.audio` with `id`, `slug`, and
`username`, and a `progress` capability URL accepting PATCH requests. Native
policies also include `extra.token`: Audacity cancels with
`DELETE /audio/AUDIO_ID?token=TOKEN` without an OAuth header. This capability is
scoped to that recording and expires with its upload URLs. Discarding removes
pending or ready audio, retires in-flight uploads, and releases its storage quota.
Explicit `public: false` means unlisted, as with Audacity's original sharing flow.

`GET /my/audio` returns `items` and Audacity's pagination keys `total`, `pages`,
`page`, and `size`. Each item supplies the required `author` string, `created`
epoch, `source.size`, and `source.duration`. `GET /audio/:id` supplies expanded
author ID, download permission, title, tags and creation/update dates for the
Audacity import dialog. `GET /download/:id` marks the preserved original as the
source format, so Audacity can select it without a lossy transcode.

This implements the upload/library/source-download subset used by Audacity and
the audio.com public audio API CRUD shape. Cover image uploads, social features,
statistics, processing/transcoding callbacks and waveform generation are not
implemented.
