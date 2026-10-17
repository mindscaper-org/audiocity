# Accounts and authentication

Audiocity accounts belong to this server. Existing audio.com accounts and tokens are not used. Configure `AUDIOCITY_PUBLIC_URL` to the server's externally reachable origin; discovery and signed upload URLs use it. Browser clients such as Soundscaper must also appear in the comma-separated `AUDIOCITY_CORS_ORIGINS` setting.

The first start creates one administrator using `AUDIOCITY_ADMIN_EMAIL` and `AUDIOCITY_ADMIN_PASSWORD`. If no password is supplied, startup prints a generated password once. Save it before restarting. Changing those environment settings later does not reset an existing account. Passwords must contain 12–256 characters and are stored using salted scrypt. Access and refresh tokens are opaque random values stored only as SHA-256 hashes.

Public registration is disabled by default. An administrator with an `all`-scoped token can create accounts through POST `/admin/users`:

```json
{"email":"person@example.org","password":"a long unique password","name":"Person"}
```

It returns HTTP 201 and the new user. Accounts created through this endpoint or public registration are ordinary users. Set `AUDIOCITY_REGISTRATION=true` to enable POST `/auth/register` with the same payload. For ordinary browser registrations, that endpoint returns HTTP 201 and the user; then sign in separately.

## Sign in and refresh

POST `/auth/token` accepts JSON and `application/x-www-form-urlencoded`. The server's own console can use the password grant:

```json
{"grant_type":"password","username":"person@example.org","password":"a long unique password","scope":"all"}
```

The response is compatible with Audacity's token parser:

```json
{"access_token":"...","token_type":"Bearer","expires_in":3600,"refresh_token":"...","scope":"all"}
```

Send `Authorization: Bearer ACCESS_TOKEN` on authenticated requests. GET `/me` (used by Audacity 3), `/auth/me`, and `/user/me` return the account, including the `id`, `username`, `avatar` string and `profile.name` fields read by Audacity. An empty avatar indicates that no avatar is configured.

Refresh with POST `/auth/token`:

```json
{"grant_type":"refresh_token","refresh_token":"..."}
```

Include the original `client_id` for an OAuth client, and `client_secret` for the configured Audacity client. Each refresh invalidates both previous tokens and returns a new pair. Refresh tokens last 30 days; access tokens last `AUDIOCITY_TOKEN_TTL_SECONDS` (3600 seconds by default). A refresh may reduce its scope but cannot expand it. POST `/auth/logout` with a bearer token revokes that token and its corresponding refresh token.

An invalid, expired or revoked refresh token returns HTTP 422 to the configured Audacity client after its client credentials have been validated. Audacity uses that terminal response to discard its stored refresh token and require sign-in again. Incorrect client credentials still return HTTP 401; invalid refresh tokens presented by the console or a dynamic OAuth client also retain HTTP 401. Refresh tokens remain bound to the client that received them.

Scopes are `public` for regular audio and `all` for native project synchronization and the account owner's permitted administration. As observed on audio.com, including `public` confines a token to the public API even if `all` is also present. A refresh requesting the already authorized subset `all` removes that restriction. Do not combine `public all` when native project access is intended. A token issued to an administrator still needs exactly `all` for `/admin/users`.

`projects` is an Audiocity extension retained for existing self-hosted clients. Explicit `public projects` grants regular audio and local project storage without administrator APIs. This extension is not supported by audio.com and should only be requested after detecting Audiocity's capabilities. OAuth access lifetime is server policy, not a fixed protocol constant: audio.com has returned one-year access tokens without the optional `scope` response field, while Audiocity retains a configurable one-hour default and includes the granted scope. Clients must accept either valid response shape and use its actual `expires_in`.

## Change or recover a password

POST `/auth/password` with the account's bearer token:

```json
{"current_password":"the existing password","new_password":"a new long unique password"}
```

A successful change returns HTTP 204 and signs out every session for that account. Sign in again using the new password. Its outstanding authorization codes are revoked; pending consent forms on the server expire and must be reopened. Invalid current credentials or a password shorter than twelve characters do not revoke sessions.

The offline administration command described in the [README](../README.md) recovers a lost password without requiring an existing session. It uses the same password validation and revocation behavior. The persistent database must be retained to recover an existing account; deleting the data volume creates a new server instead.

## Soundscaper and other browser clients

Discover the endpoints at GET `/.well-known/oauth-authorization-server`. Register a public client with POST `/auth/client`:

```json
{"client_name":"Soundscaper","redirect_uris":["https://editor.example.org/oauth/callback"],"token_endpoint_auth_method":"none"}
```

The HTTP 201 response contains a generated `client_id`. Redirects must be HTTPS, or HTTP on a loopback address, without URL credentials or fragments. At authorization time the complete redirect string, including its port and path, must exactly match a registered string. Registration supports up to ten redirects per client.

Generate a random PKCE verifier of 43–128 unreserved characters and its base64url-encoded SHA-256 challenge. Open:

```text
/auth/authorize?response_type=code&client_id=CLIENT_ID&redirect_uri=ENCODED_REDIRECT&scope=all&state=RANDOM_STATE&code_challenge=CHALLENGE&code_challenge_method=S256
```

The user signs in on Audiocity's HTML consent screen. The server binds consent to that browser with an HTTP-only SameSite cookie. The form expires after ten minutes. Approval redirects to the registered URI with `code` and the original `state`; cancellation returns `error=access_denied` and `state`. The client must verify its `state` before exchanging the code.

POST `/auth/token`:

```json
{"grant_type":"authorization_code","client_id":"CLIENT_ID","redirect_uri":"https://editor.example.org/oauth/callback","code":"...","code_verifier":"..."}
```

Codes expire after two minutes, are single-use, and are bound to the account, client, exact redirect, granted scope and PKCE challenge. Public clients always require S256 PKCE and cannot use the password grant. This repository implements the server integration points; an editor must configure its API base and OAuth flow to use them.

## Audacity authentication compatibility

Compatibility is derived from Audacity source pinned at [`b482a5e3ee5443c0a438908aaf1caf09250171a9`](https://github.com/audacity/audacity/tree/b482a5e3ee5443c0a438908aaf1caf09250171a9), particularly [ServiceConfig.cpp](https://github.com/audacity/audacity/blob/b482a5e3ee5443c0a438908aaf1caf09250171a9/au3/libraries/au3-cloud-audiocom/ServiceConfig.cpp), [OAuthService.cpp](https://github.com/audacity/audacity/blob/b482a5e3ee5443c0a438908aaf1caf09250171a9/au3/libraries/au3-cloud-audiocom/OAuthService.cpp) and [Au3CloudService](https://github.com/audacity/audacity/blob/b482a5e3ee5443c0a438908aaf1caf09250171a9/src/au3cloud/internal/au3cloudservice.cpp). It is covered by protocol tests rather than an automated run of an Audacity desktop binary.

Audacity 3 selects its cloud server through `[CloudServices/AudioCom]` in `audacity.cfg`. Follow the [Audacity 3 setup instructions](clients.md#audacity-3-select-your-server-in-audacitycfg) for file locations, a complete configuration example, and account linking. Audacity 4 currently hardcodes its server endpoints and requires a custom build to connect to Audiocity; the Audacity 3 preference-file instructions do not apply to it.

Set all of the Audacity 3 origin preferences together: Audacity sends its access token to `AuthWithRedirectURL` when opening a browser session. Audiocity validates the token and user, resolves Audacity's relative destination paths against its configured public origin, and accepts only destinations on that same origin. It hands the browser console its token using a noncached page with a nonce-restricted script. The script immediately removes the token-bearing URL from browser history, sets the console session to the account used in Audacity, and automatically redirects to the requested page. No extra confirmation click is required. A styled fallback link remains available if automatic navigation cannot run. This browser handoff is separate from the Help menu's manual linking-token callback.

Audacity 3's project-owner cache uses integer keys and cannot retain legacy UUID project IDs. Audiocity now returns stable numeric IDs for native projects, including existing projects, to support this cache and the desktop downloader. Older cached UUID references can still build `//projects/PROJECT_ID` with an empty username after a successful save. Audiocity recognizes only this project-page pattern (or `//projects` for the project list) and restores the authenticated username before validating the destination's origin. Other external destinations remain rejected.

The client ID and shared secret must match `AUDIOCITY_AUDACITY_CLIENT_ID` and `AUDIOCITY_AUDACITY_CLIENT_SECRET`. They are Audiocity's own registration, independent of audio.com's registration. Audacity sends them with password, authorization-code and refresh grants. Audacity 3 exchanges codes without PKCE. Its direct application callback receives `audacity://link?code=...` and exchanges it with `redirect_uri=audacity://link`. Its Help menu instead expects a manually pasted URI: configure `OAuthRedirectURL` and the login page's `redirect_uri` to `${AUDIOCITY_PUBLIC_URL}/auth/callback`, where Audiocity displays `audacity://link?authorization_code=...`. That parameter tells Audacity to use the configured `OAuthRedirectURL` in the exchange. The callback page accepts only unexpired, unused codes bound to the configured Audacity client and this server's callback; it does not consume the code when displaying it.

Once an Audacity 4 custom build points at this server with matching OAuth client credentials, its inspected in-app email/password sign-in uses the password grant. Its in-app account creation sends `email`, `password`, `client_id` and `client_secret` to `/auth/register`; when public registration is enabled, Audiocity returns HTTP 200 and the token response expected by that client. Ordinary browser registration retains its HTTP 201 user response.

Audacity 4's browser authorization opens `/auth/authorize` with an ephemeral `http://127.0.0.1:PORT/` callback, no scope, and no PKCE challenge. Only the configured Audacity client receives this restricted loopback exception and defaults to `all` scope. The resulting code is still bound to the exact callback string, one-time and short-lived, and its exchange requires the configured client secret. Dynamic clients always use their exact registered redirects and PKCE. Audacity's `authclient` provider parameter is accepted for protocol compatibility; the consent screen authenticates local Audiocity accounts and does not implement Google, Apple or other social identity providers.

See [project-protocol.md](project-protocol.md) for the native block synchronization and whole AUP3/AUP4 archive transports. Authentication compatibility does not make an arbitrary Audacity release understand another release's internal project serialization.
