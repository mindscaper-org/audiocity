# Library and metadata

Sign in and open **Library**. **Audio** and **Projects** are tabs on the same page. Audio entries open dedicated playback pages; projects retain their cloud revisions, previews and archive downloads.

## Upload and play

Use **+ Upload** in the header to select audio files, `.aup3` files or `.aup4` files together. Audio goes into the Audio tab. AUP3/AUP4 files go into Projects as whole-file archives. Close an archive project in its editor first so the file contains all changes, including any pending SQLite write-ahead log data.

Playback pages display the recording's metadata and its player. Public and unlisted uploads can be played by a visitor with the link. Private uploads require the owner's session. Server-directory recordings require an Audiocity account. Only an owner, or an administrator managing server-directory recordings, can edit metadata.

WavPack uploads use a local WebAssembly decoder in the browser, including the lossless 24-bit audio Audacity uploads by default. Audiocity stores and serves the original file; decoding does not send audio to an external service or create server-side transcoded copies. The player supplies ordinary playback and seeking controls. Other supported audio files use the browser's native codec support. To bound browser memory, WavPack playback accepts up to 64 MiB of encoded audio and 128 MiB of decoded float32 PCM, at up to eight channels and 384 kHz; larger originals remain downloadable. Decoder source, provenance and limits are also available in [its notice](../assets/wavpack/NOTICE.md).

## Edit a recording

Open a recording and choose **Edit** to change its title, slug, category, tags, description, license, visibility and download setting. The slug gives the recording a readable URL under its owner's username. The stable ID playback URL continues to identify the same recording after a slug change.

Categories are managed by administrators. Defaults are Music, Podcast, Voiceover, SFX, Cover, Beats, Audiobook, Recording and Other. Tags and descriptions are controlled by the recording's owner. License choices include No license selected, All rights reserved, CC0, and the six Creative Commons 4.0 licenses: CC BY, CC BY-SA, CC BY-ND, CC BY-NC, CC BY-NC-SA and CC BY-NC-ND.

Choose **Manage files** for the metadata table. Select a cell or a rectangle with Shift and edit several values together. Copy and paste tab-separated cells from a spreadsheet, including quoted cells containing newlines or tabs. The page provides keyboard instructions for selection, editing, filling and undo. Changes stay as drafts until **Save changes**; invalid or unauthorized changes leave the drafts available for correction. Saving a batch validates every row and applies it as one transaction.

## Shared recordings

The shared view combines ready public uploads from other users with audio from the configured `AUDIOCITY_SHARED_DIR`. Public uploads remain owned by their uploader. Folder recordings can be described and categorized by administrators without rewriting the source files. Private and unlisted recordings are not included in the shared view.

Each account can turn **Include shared files in my library** off to show only its own uploads by default in the browser library. This preference persists on the server. The library's source selector lets you explicitly browse your files, shared files, or both. Native Audacity lists and the public audio library API contain owned uploads, so editors can safely build account-scoped recording links. Public API search discovers listed uploads across accounts independently of this browser preference.

See [library API and directory configuration](library-api.md) for server setup, indexing, permissions and API details. The directory must be accessible inside the container; a Windows folder can be mounted through its WSL `/mnt/c/...` path. The configured path is the path inside the container, not the Windows drive-letter path.
