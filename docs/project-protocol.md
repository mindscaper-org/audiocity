# Project synchronization protocol

Audiocity implements two project transports. Both preserve the submitted bytes, require project-scoped authentication, use the same revision history, and enforce ownership on every metadata route. Native transport is derived from the Audacity source at commit [`b482a5e3ee5443c0a438908aaf1caf09250171a9`](https://github.com/audacity/audacity/tree/b482a5e3ee5443c0a438908aaf1caf09250171a9/au3/libraries/au3-cloud-audiocom), principally `ServiceConfig.cpp`, `sync/CloudSyncDTO.cpp`, `sync/LocalProjectSnapshot.cpp` and `sync/ResumedSnaphotUploadOperation.cpp`.

This is a compatible self-hosted server implementation, not an audio.com service or an agreement with audio.com. Windows Audacity 3.7.9 has been tested manually for login, audio upload, cloud project save/reopen, and preview generation against a WSL-hosted server. Other versions still require validation. Audacity 3 can select this server through `audacity.cfg`; Audacity 4 currently hardcodes its cloud server and requires a custom build. Follow the [client setup guide](clients.md) to configure the API, website, callback and OAuth client settings. Soundscaper also needs a client integration configured for this API; this repository does not modify Soundscaper.

## Native Audacity block snapshots

Create a project and its first pending revision:

```http
POST /project
Authorization: Bearer TOKEN
Content-Type: application/json

{"name":"Session","blocks":["BLOCK_HASH_1","BLOCK_HASH_2"]}
```

The native response is HTTP 200, matching the live audio.com project endpoint:

```json
{
  "project": {"id":"PROJECT_ID","head":{"id":"SNAPSHOT_ID"}},
  "snapshot": {"id":"SNAPSHOT_ID","parent_id":"","date_synced":0},
  "sync": {
    "file":{"id":"BLOB_ID","url":"PUT_URL","success":"SUCCESS_URL","fail":"FAIL_URL"},
    "mixdown":{"id":"BLOB_ID","url":"PUT_URL","success":"SUCCESS_URL","fail":"FAIL_URL"},
    "blocks":[{"id":"BLOCK_HASH_1","url":"PUT_URL","success":"SUCCESS_URL","fail":"FAIL_URL"}]
  }
}
```

The example abbreviates project and snapshot metadata. Actual responses supply every mandatory field deserialized by the pinned Audacity DTO: project identity, username, author, slug, name, details, creation/update times, size, head and latest synced ID; snapshots include parent, creation/update/sync times, metadata size and block size. Dates are Unix seconds. Unfinished revisions have `date_synced: 0`.

Native project IDs returned to clients are stable positive decimal strings. Audacity 3 uses these IDs in an integer SQLite key and in unquoted attached-database names and savepoints, so UUIDs prevent it from reopening a downloaded project even when uploads and listing succeed. Audiocity maps native projects to numeric IDs without rewriting project content, revisions, or stored UUIDs. Existing UUID references remain accepted by the project and revision routes; refreshing the cloud project list returns the numeric IDs needed for a fresh desktop download. Deleted numeric IDs are not reused. Whole-file AUP3/AUP4 archives retain their UUID IDs. Clients should treat every project ID as an opaque string.

1. PUT the exact project metadata snapshot to `sync.file.url`. It is Audacity's serialized project snapshot, not an entire `.aup3` SQLite database. POST to its `success` URL after the PUT succeeds. On a definitive failure, POST to its `fail` URL.
2. Upload each descriptor from `sync.blocks` in the same way. The descriptor's `id` is the requested Audacity block hash normalized to lowercase, as on audio.com; Audacity maps hashes without case sensitivity. Upload bytes are Audacity's WavPack block representation.
3. POST an empty body to `/project/PROJECT_ID/snapshot/SNAPSHOT_ID/sync` once the project metadata and every block have been successfully uploaded and confirmed. Native completion returns HTTP 204 without a body. GET the expanded snapshot to retrieve its metadata and download URLs.

The mixdown descriptor accepts an optional audio preview and does not block project completion. Audacity 3's **File → Save Project → Update Cloud Audio Preview** renders and uploads a mixdown (normally MP3). Audiocity detects its container even when the PUT declares `application/octet-stream`, records the correct audio MIME type, and preserves the original bytes without transcoding. Unsupported containers are rejected without preventing project synchronization. Existing mixdowns with incorrectly declared MIME types are detected again at startup; unrecognized legacy bytes remain stored but are not advertised as previews.

The browser console's **Project library → Actions → Preview audio** plays the latest available mixdown. **Update preview in Audacity** opens the editor's `audacity://generate-audio?projectId=PROJECT_ID` handler. Refresh the library when generation finishes. Revision actions also offer playback when that revision has a mixdown. Browser codec support determines playback.

Project metadata includes `preview: null` or `{url, mime, size, snapshot_id, is_current}`. It selects the newest synchronized revision with a confirmed, recognized mixdown. `is_current` is false when a later synchronized save has no preview; the console labels this older audio rather than implying that every save renders a new mixdown. Expanded snapshot metadata and revision lists include `preview: null` or `{url, mime, size, snapshot_id}` for that specific revision. Preview URLs are signed bearer capabilities, expire after one hour, and support HTTP byte ranges for seeking. Fetch fresh metadata to obtain a new URL. Project ownership checks apply before these URLs are issued. A mixdown may finish uploading after its project revision synchronizes.

Completion returns HTTP 409 while required bytes are missing. Repeating successful completion returns the same revision without moving the project head backwards. A newer pending head prevents an older unfinished revision from completing. Already synchronized revisions remain readable in history.

GET `/project/PROJECT_ID/snapshot/SNAPSHOT_ID/sync` returns resumable upload descriptors. Its `blocks` array contains only blocks still missing. An already confirmed metadata file has an empty `file.url` (and empty success/failure URLs), which tells Audacity to discard its pending local metadata upload. Failed or expired missing-upload capabilities are renewed. Successfully confirmed data is reused. Upload URLs are expiring bearer capabilities: protect them as credentials.

Upload URLs include `X-Amz-Date` and `X-Amz-Expires` hints matching the stored capability expiry. Audacity uses these fields to detect an expired cached upload and request fresh descriptors. The server validates the bearer token and its stored expiry on every upload request. Desktop caches containing older token-only URLs need fresh descriptors from a new save or an explicit resume; the server cannot rewrite URLs already stored in a client database.

If an older server's deletion race removed a reused block, `/sync` also returns an upload descriptor for that retained hash reference. A client with the original block can upload it to repair the revision without changing its ID or moving a newer project head. Completion returns HTTP 409 until every referenced block is confirmed, including when retrying a previously synchronized revision. Expanded synchronized revisions also return HTTP 409 while required bytes are missing; basic project metadata remains available to locate the revision for repair.

Audio blocks deduplicate by `(owner, claimed Audacity hash)`, ignoring hash case, including reuse between that owner's projects. Existing mixed-case records remain readable and reusable without rewriting their blobs or historical references. They are never reused across users. Hashes identify the decoded Audacity blocks, not the uploaded WavPack bytes; the server deliberately does not decode native snapshots or verify that a claimed hash represents those decoded samples. Clients must provide consistent hashes. Confirmed uploads are immutable.

## Revisions and concurrency

Create another revision with:

```http
POST /project/PROJECT_ID/snapshot
Authorization: Bearer TOKEN
Content-Type: application/json

{"head_snapshot_id":"CURRENT_HEAD","blocks":["BLOCK_HASH_1","NEW_HASH"]}
```

Only missing blocks receive upload descriptors. Metadata snapshots always receive a fresh descriptor. A stale head returns HTTP 409, which the pinned Audacity client recognizes as a project version conflict. `force: true` explicitly permits a branch from a known earlier snapshot. It creates a new revision and preserves other revisions; it does not overwrite historical bytes. An unknown or foreign parent ID is rejected even with force enabled.

Audiocity sends `Connection: close` on POST responses to work around Audacity 3.7.9's CURL handle reuse bug. The client caches POST handles when a response has a `Keep-Alive` header, leaves `CURLOPT_POSTFIELDS` set after a bodyless POST, and can then send unrelated memory instead of the JSON for a later Ctrl+S save. Closing POST connections suppresses Node's implicit `Keep-Alive` header and makes the client discard those handles; GET and upload PUT connections remain reusable. Reverse proxies must also suppress `Keep-Alive` on downstream POST responses (and may close those connections). Malformed JSON remains rejected. Audacity's local filename suffixes such as `_1` do not change the cloud project identity.

- GET `/project` lists the user's native block projects. It accepts `page`, `per-page` (1–100), and `q`. Pagination contains Audacity's required `total`, `pages`, `page` and `size` fields.
- GET `/project/PROJECT_ID` returns project metadata and its latest head.
- PATCH `/project/PROJECT_ID` changes `name` or `details`.
- GET `/project/PROJECT_ID/snapshot` lists revisions, including pending ones, with the same pagination.
- GET `/project/PROJECT_ID/snapshot/SNAPSHOT_ID?expand=blocks,file_url` returns snapshot metadata and signed download URLs for confirmed metadata and blocks. Downloads preserve the original bytes.
- DELETE `/project/PROJECT_ID/snapshot/SNAPSHOT_ID` removes an abandoned revision. A current synchronized revision or ancestor of another revision cannot be removed. Removing a pending head restores its predecessor. Cancelling the only pending revision also removes its empty project.
- DELETE `/project/PROJECT_ID` removes the complete project history and its blobs. Blocks still referenced by the same owner's other projects remain available.

The head may be pending. `latest_synced_snapshot_id` identifies the latest completed revision suitable for download, and `latest_synced_format` identifies that revision's format (empty before any revision completes). The top-level `format` describes the head, which may select a different archive generation from the last completed revision. Clients should retain local work until completion succeeds.

## Soundscaper whole-file AUP3 and AUP4 transport

Select whole-file transport explicitly when creating a project:

```http
POST /project
Authorization: Bearer TOKEN
Content-Type: application/json

{"name":"Portable project","format":"aup4","size":123456}
```

Use `format: "aup3"` for AUP3. This is an Audiocity extension, absent from audio.com's API. Archive creation returns HTTP 201; its completion returns HTTP 200 with the expanded snapshot, preserving existing archive clients. Upload the complete, standalone, checkpointed SQLite file to `sync.file.url`, confirm it, and complete `/sync` as above. The optional `size` is the exact upload byte count; when supplied, a mismatch rejects the upload. Archive uploads must begin with SQLite's file header. This check does not certify database integrity, application schema, or semantic compatibility; the server stores opaque files without importing, upgrading or converting them. Supply a complete checkpointed file, not a database requiring external WAL/SHM sidecars.

Whole-file revisions have `transport: "file"`, their selected `format`, and an empty `blocks` array. Revision downloads expose the complete file through `file_url`. Further revisions use `head_snapshot_id` and may explicitly select AUP3 or AUP4 while retaining historical files. Switching an existing project between native block transport and whole-file transport is rejected; create another project instead.

GET `/project?transport=all` includes both transports. GET `/project?transport=file` includes only whole-file projects; `?format=aup3` or `?format=aup4` filters precisely. Native `/project` defaults to block projects because native Audacity cannot reconstruct its cloud snapshot from a whole SQLite archive. A client must use the declared transport when opening a project.

## Deliberate limits

Audiocity does not transcode, reconstruct `.aup3`/`.aup4` databases from native block snapshots, convert between Audacity generations, or publish public project sharing. There is no background merge or conflict resolution. The two transports provide persistent versioned storage through explicit upload and download protocols; an editor remains responsible for decoding and editing its supported formats.
