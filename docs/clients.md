# Configure editor clients

The server implements audio.com-style storage APIs at your own origin. It does not replace DNS, use audio.com accounts, or intercept the real service. Each editor needs a way to configure its API and authorization origins. Keep its local project backup until you have tested upload, reopen, and download against your server.

## Audacity

The compatibility target is the native client source at commit [`b482a5e3ee5443c0a438908aaf1caf09250171a9`](https://github.com/audacity/audacity/tree/b482a5e3ee5443c0a438908aaf1caf09250171a9). The unversioned project endpoints and legacy audio upload endpoints match its DTO and transfer sequence. Audacity creates native snapshots and WavPack blocks itself; Audiocity stores and returns those bytes.

### Audacity 3: select your server in audacity.cfg

Audacity 3 reads its cloud server settings from `audacity.cfg`. Its [ServiceConfig.cpp](https://github.com/audacity/audacity/blob/Audacity-3.7.7/libraries/lib-cloud-audiocom/ServiceConfig.cpp) reads the `/CloudServices/AudioCom/` preferences, so you can point a build with cloud support at Audiocity by editing that file.

1. Start Audiocity and confirm you can sign in to its browser console with an account on your server.
2. If Audacity is linked to audio.com, unlink that account before switching servers. Close every Audacity window so it does not overwrite your changes on exit.
3. Back up `audacity.cfg`, then open it in a plain text editor. Common locations are:

   | Platform | Configuration file |
   |---|---|
   | Windows | `%APPDATA%\audacity\audacity.cfg` |
   | macOS | `~/Library/Application Support/audacity/audacity.cfg` |
   | Linux | `~/.config/audacity/audacity.cfg` (or `$XDG_CONFIG_HOME/audacity/audacity.cfg` if set); existing `~/.audacity-data/audacity.cfg` installations retain that location |

   If you use Audacity's **Portable Settings** folder, edit the `audacity.cfg` in that folder instead. See Audacity's [preferences documentation](https://manual.audacityteam.org/man/preferences.html#stored) and [Linux configuration directory selection](https://github.com/audacity/audacity/blob/Audacity-3.7.7/libraries/lib-files/FileNames.cpp).
4. Add or update the following section. If `[CloudServices/AudioCom]` already exists, update its entries rather than adding a duplicate section. This example uses Audiocity's default local server and client credentials:

   ```ini
   [CloudServices/AudioCom]
   ApiEndpoint=http://localhost:8080
   OAuthClientID=audiocity-desktop
   OAuthClientSecret=audiocity-local-desktop
   OAuthRedirectURL=http://localhost:8080/auth/callback
   OAuthLoginPage=http://localhost:8080/auth/authorize?response_type=code&client_id={auth_client_id}&redirect_uri=http%3A%2F%2Flocalhost%3A8080%2Fauth%2Fcallback&scope=all
   FrontendURL=http://localhost:8080
   AuthWithRedirectURL=http://localhost:8080/auth/check-and-redirect
   TourPage=http://localhost:8080/
   FinishUploadPage=http://localhost:8080/
   ```

   For a remote server, replace every `http://localhost:8080` with its reachable HTTPS origin, such as `https://audiocity.example.org`, matching `AUDIOCITY_PUBLIC_URL`. Also replace the URL-encoded `redirect_uri` in `OAuthLoginPage` with that server's encoded `/auth/callback` URL. The decoded value must exactly match `OAuthRedirectURL`. Keep `ApiEndpoint` as the origin without a trailing slash or `/v1` suffix.

   `OAuthClientID` and `OAuthClientSecret` must match the server's `AUDIOCITY_AUDACITY_CLIENT_ID` and `AUDIOCITY_AUDACITY_CLIENT_SECRET`. The login-page `{auth_client_id}` placeholder is expanded by Audacity; leave it literal. These are local compatibility values, independent of audio.com credentials and your Audiocity account password.
5. Save the file and restart Audacity. Open **Help → Link audio.com account…**, then choose **Sign-in and get the token** to open your server's consent page. Sign in with your Audiocity account and choose **Allow access**. The browser displays a token starting with `audacity://link?authorization_code=`. Copy the entire value into Audacity's **Token** field and choose **Continue** within two minutes. The menu still uses the audio.com name. Test saving and reopening a small cloud project before relying on synchronization.

The Help menu uses a manual token dialog; a browser callback does not fill its Token field. Audiocity's `/auth/callback` page supplies the complete URI that dialog expects. Audacity 3 also fetches `/me` after either browser linking or direct password sign-in; that response supplies the account ID used by the upload flow's browser handoff.

To switch back, unlink the Audiocity account, close Audacity, and restore your backed-up configuration (or remove the overridden entries to restore audio.com defaults), then restart and link your audio.com account again.

The browser Library combines Audio and Projects tabs. **Include shared files in
my library** controls whether the browser library includes the shared server
directory and other users' public uploads by default. Audacity's native audio
browser uses the owner's uploads at `/my/audio`; shared-folder and other users'
entries remain available in the browser console. Public API audio lists also
contain the owner's uploads, while public search ignores this browser preference.
See the [library guide](library.md) for uploads, WavPack playback, metadata editing
and the shared source selector.

Change all relevant origins together. The browser-link, post-upload, tour, and authenticated browser-redirect defaults also point at audio.com; changing only the API origin is insufficient. In particular, Audacity's browser-session redirect carries a token and must point to your server.

### Audacity 4: select your server in Qt settings

Audacity 4.0.1 reads the same logical `CloudServices/AudioCom/` settings through its Qt settings backend. Its endpoints can be overridden without recompiling. Editing Audacity 3's `audacity.cfg` does not update that backend. These instructions follow the inspected 4.0.1 source and Qt's storage rules; an Audacity 4 desktop session against Audiocity has not been tested here.

Unlink the current account, close Audacity, and back up its settings before editing. For standard stable builds, the user settings locations are:

| Platform | Audacity 4 settings |
|---|---|
| Windows | `%APPDATA%\Audacity\Audacity4.ini` |
| Linux | `~/.config/Audacity/Audacity4.ini`, or `$XDG_CONFIG_HOME/Audacity/Audacity4.ini` |
| macOS | Preferences domain `org.audacityteam.Audacity4`, normally stored in `~/Library/Preferences/org.audacityteam.Audacity4.plist` |

Development builds use `Audacity4Development` instead of `Audacity4`. Windows portable builds relocate the INI root to their `Data/settings` tree.

On Windows and Linux, add or update the following entries in the INI file. Qt represents the nested keys with backslashes under `[CloudServices]`; do not add a second copy of an existing key.

```ini
[CloudServices]
AudioCom\ApiEndpoint=http://localhost:8080
AudioCom\OAuthClientID=audiocity-desktop
AudioCom\OAuthClientSecret=audiocity-local-desktop
AudioCom\OAuthRedirectURL=http://localhost:8080/auth/callback
AudioCom\OAuthLoginPage=http://localhost:8080/auth/authorize?response_type=code&client_id={auth_client_id}&redirect_uri=http%3A%2F%2Flocalhost%3A8080%2Fauth%2Fcallback&scope=all
AudioCom\FrontendURL=http://localhost:8080
AudioCom\AuthWithRedirectURL=http://localhost:8080/auth/check-and-redirect
AudioCom\TourPage=http://localhost:8080/
AudioCom\FinishUploadPage=http://localhost:8080/
```

On macOS, use native preferences rather than editing a cached plist directly. Qt maps the logical slashes to dots in the native key names. For each entry above, write its value using `defaults write org.audacityteam.Audacity4 CloudServices.AudioCom.SETTING -string 'VALUE'`, replacing `SETTING` and `VALUE`. For example:

```sh
defaults write org.audacityteam.Audacity4 CloudServices.AudioCom.ApiEndpoint -string 'http://localhost:8080'
defaults write org.audacityteam.Audacity4 CloudServices.AudioCom.OAuthClientID -string 'audiocity-desktop'
```

Apply all nine entries, including the frontend, tour and authenticated redirect origins. Replace the local URLs and client values as described in the Audacity 3 example above; preserve the encoded callback URL inside `OAuthLoginPage`. Restart Audacity, sign in with your Audiocity account, and test a small save and reopen before relying on it. The inspected Audacity 4 browser sign-in uses its own ephemeral `http://127.0.0.1:PORT/` callback; the configured login-page and manual callback values also keep legacy linking paths on this server. Audiocity supports its password sign-in and optional registration contracts. See [authentication compatibility](authentication.md#audacity-authentication-compatibility).

Source references: Audacity 4.0.1 [cloud setting reads](https://github.com/audacity/audacity/blob/d82386ce31175f1641d0450566a73a993c635a75/au3/libraries/au3-cloud-audiocom/ServiceConfig.cpp#L132), [Qt settings adapter](https://github.com/audacity/audacity/blob/d82386ce31175f1641d0450566a73a993c635a75/src/au3wrap/internal/au3commonsettings.cpp#L141), [application identity](https://github.com/audacity/audacity/blob/d82386ce31175f1641d0450566a73a993c635a75/src/app/main.cpp#L94), its pinned framework's [storage format and portable paths](https://github.com/musescore/muse_framework/blob/3ba3cd6886433b41759d2d7adef8aef9bbbd546b/framework/global/settings.cpp#L49), and Qt's [platform storage rules](https://doc.qt.io/qt-6/qsettings.html#platform-specific-notes) and [macOS key mapping](https://github.com/qt/qtbase/blob/v6.8.3/src/corelib/io/qsettings_mac.cpp#L49).

### Project compatibility

Native cloud-project list/open uses `/project` without a format filter. Whole-file AUP3/AUP4 archives are intentionally absent from that list because the native downloader expects its serialized metadata plus separate blocks. Importing a whole-file archive into Audacity is a normal file-open operation after downloading the file through the console or archive API.

Login, audio upload, cloud project save/reopen, and preview generation have been tested manually with Windows Audacity 3.7.9 against a WSL-hosted server. Automated tests verify the HTTP contract and browser workflows; they do not launch Audacity. Other editor versions still require validation.

**Update Cloud Audio Preview** uploads audio that can be played in the console under **Project library → Actions → Preview audio**, including in revision history. Refresh the library after generation finishes. A regular save does not render a new preview, so older audio is labeled when it belongs to an earlier revision. Audacity may add a local filename suffix such as `_1` when reopening; this does not rename the cloud project.

## Soundscaper or another browser editor

Soundscaper uses audio.com by default. In Preferences → Advanced, under audio.com
API, set Server URL to this server's HTTPS origin and choose Save server. Then open
Window → audio.com and connect with your Audiocity account. Changing the server
signs out the old connection; Use audio.com restores the default. Soundscaper
registers its own public OAuth client with the selected server and uses PKCE.
No server deployment setting or shared OAuth client credential is needed to
switch an individual editor's backend.

The selected origin must be reachable from Soundscaper's API deployment. HTTP
loopback is supported only for local development; a remote Pages deployment
cannot reach a server on your laptop's localhost. Audiocity's
`AUDIOCITY_PUBLIC_URL` must match its reachable origin so registration, browser
consent and capability URLs remain on the same server. Other clients making
direct browser API requests must additionally be listed in
`AUDIOCITY_CORS_ORIGINS`.

With both checkouts' dependencies installed, the Soundscaper integration worktree
provides an isolated validation run:

```sh
cd ../Soundscaper-audio-com
npm run build
npx playwright test --config playwright.audiocity.config.mjs
```

The harness starts temporary Audiocity and Soundscaper Pages/D1 services, registers
a disposable OAuth client, and cleans up on exit. Set `SCAPE_AUDIOCITY_CHECKOUT`
when this repository is not the worktree's `../audiocity` sibling. It validates
real browser OAuth, audio upload/search/playback, and byte-preserving AUP3/AUP4
archive transfers followed by opening each downloaded file in Soundscaper.
It does not demonstrate native Audacity desktop compatibility.

Register a public OAuth client once:

```http
POST /auth/client
Content-Type: application/json

{"client_name":"My Soundscaper","redirect_uris":["https://editor.example/auth/audiocity/callback"]}
```

Use the returned `client_id`. Authorization uses code flow with PKCE S256; retain a fresh verifier and state for each attempt, and validate state on return. See the [authentication guide](authentication.md) for the exact exchange.

- Scope `public` permits regular audio operations.
- Scope `projects` permits project upload/list/sync/download.
- Scope `public projects` is Audiocity's explicit extension granting both regular audio and local project storage without administrator APIs; Soundscaper requests it after recognizing the server's archive capabilities.
- Scope `all` is required by the native Audacity compatibility flow and also grants the user's administrative capabilities when that user is an administrator.
- Combining `public all` confines native routes to the public API, matching audio.com; request `all` alone for native synchronization.

Audio upload and library APIs are documented in [audio-api.md](audio-api.md). For complete editor project files, create a project with `format: "aup3"` or `format: "aup4"`, upload the standalone checkpointed SQLite export, and complete the revision as described in [project-protocol.md](project-protocol.md). List with `/project?transport=all` or a format filter. Download the signed `file_url` and pass the bytes to the editor's supported project importer.

Store the OAuth refresh token using the editor's normal credential storage. Signed upload/download URLs are bearer capabilities and should not be embedded in permanent saved project data. A project ID/snapshot ID can be retained and used to request fresh URLs later.
