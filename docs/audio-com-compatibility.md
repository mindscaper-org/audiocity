# audio.com compatibility contract

Audiocity implements the audio and native project subset used by editor clients.
Its API origin can replace audio.com's API origin for those operations; accounts,
OAuth clients and consent belong to the selected server. It does not implement
every audio.com product endpoint.

The public contract is audio.com's [OpenAPI document](https://api.audio.com/v1/openapi.json),
checked again on 2026-10-17. Native project behavior was compared with
authenticated audio.com tests on 2026-10-15 and the released Audacity
[3.7.9](https://github.com/audacity/audacity/tree/86d74c770974b25188ca2f23bcce47c1181bd08a)
and [4.0.1](https://github.com/audacity/audacity/tree/d82386ce31175f1641d0450566a73a993c635a75)
source. The parity, native upload/resume/cancellation, and public audio tests
record regressions for the concrete differences found in those comparisons:

- Native project/snapshot creation returns 200 with `project`, `snapshot`, and
  `sync`. Native completion returns 204 with no body, including repeat completion.
- Native creation descriptors and downloaded block hashes use lowercase; GET
  snapshot `/sync` uses uppercase IDs to match Audacity's persisted pending-block
  lookup. Block reuse remains case-insensitive within an owner. Upload URLs expose
  `X-Amz-Date` and `X-Amz-Expires` for Audacity's cached-URL expiry check, while
  the token remains the upload credential.
- `public all` is confined to public routes; a refresh narrowing to `all` permits
  native project access. User-agent impersonation is unnecessary.
- Public audio creation requires `mime`, `size`, and `category`; its omitted
  `is_listed` defaults to unlisted. A ready unlisted recording is accessible by its
  direct URL and absent from search. Existing private uploads remain private.
- The public audio library defaults to pages of 50. Search uses pages of ten.
- Invalid or expired refresh tokens return 422 for the configured Audacity client,
  which uses that status to unlink a dead session. OAuth expiry comes from the
  configured provider; a one-year response is valid.
- Legacy `/audio` upload policies include `extra.token`; Audacity's token-scoped
  `DELETE /audio/ID?token=...` discard removes pending or completed uploads and
  releases their storage reservation.
- Cancelling a native project's first revision keeps its stable project ID for a
  subsequent save. Empty native identities stay out of project list results; whole-file
  archive cancellation can remove the empty archive project.
- Public audio responses use `voice-over` and `sound-design` category IDs and
  preserve the distinct `none` license, which is also the default for API uploads.
  Library-only custom categories serialize as `other` in the public API and retain
  their full category in `/library/audio`.

Both servers use OAuth code flow with PKCE S256 for registered public clients,
presigned PUT uploads followed by explicit success/failure hooks, owner-scoped
library CRUD, and signed downloads supporting byte ranges. Capability URLs are
opaque and must never receive the provider OAuth bearer token. Public audio list,
view, update, and delete remain owner-only; search returns ready listed uploads
across accounts independently of browser shared-library preferences. Native
`/my/audio` also contains owned uploads, matching Audacity 4's owner-scoped browser
link construction.

The native sync contract carries serialized metadata and WavPack blocks, not a
complete AUP3 database. Audiocity accepts and returns these bytes without decoding
them. The project's whole-file AUP3/AUP4 archive transport, explicit `projects`
scope, private audio, capability discovery, server console and administration are
Audiocity extensions. Existing archive creation/completion retain their 201/200
responses and cannot stand in for native audio.com project synchronization.

This compatibility does not include collections, cover-image uploads, social
operations, statistics, subscription policies, processing/transcoding, waveforms,
or author/collection search results. Audio search matches literal substrings
rather than audio.com's relevance ranking. The server does not transcode media;
formats other than WavPack depend on the browser's native codec support. Windows
Audacity 3.7.9 has been tested manually for login, audio upload, cloud project
save/reopen, and preview generation against a WSL-hosted server. Other versions
still require validation.

Audiocity's browser playback adds a local WebAssembly decoder for WavPack
originals. Its shared-library extension can include a configured server directory
and other users' ready public uploads through the browser and `/library/audio`
extension. Users can choose its default inclusion persistently; explicit console
source filters remain available. These shared-folder files are excluded from the
audio.com-compatible list and search routes. Audio editing and deletion stay owner-only, with administrators able
to edit metadata for server-directory recordings. See the [library API](library-api.md).
