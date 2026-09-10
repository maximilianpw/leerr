# Native shared-server integration

The iOS and macOS source targets now use `LeerrAPI` for the versioned `/api/v1`
contract. The adapter provides Leerr login and bearer authentication, current
user and connection state, paginated library/search and album tracks, shared
requests, resolution/editions, recommendations, and stream tickets. API URLs
are rooted at the configured HTTPS origin even if a deployment URL includes a
subpath. A stream ticket is accepted only when it resolves to the same origin
and exactly one opaque path component below `/api/v1/streams/`; foreign,
scheme-relative, nested, query-bearing, and fragment-bearing URLs fail closed.

`MusicServer` remains the playback-facing boundary, but its current native
implementation is `LeerrAPI`; upstream Jellyfin/Navidrome/Lidarr/Last.fm
adapters remain in LeerrCore only as legacy code and tests. Native apps do not
compose or configure those services directly. AVFoundation byte-range loading,
queueing, audio-session behavior, and system media controls are unchanged.

Leerr passwords are submitted only to `POST /sessions` and are not persisted.
The resulting bearer is device-local in Keychain service
`dev.leerr.shared-server.sessions`. Existing service credentials use the old
`dev.leerr.credentials` service and are never enumerated, read, uploaded, or
deleted by shared-server login/logout. Logout synchronously removes only the
matching Leerr bearer before attempting `DELETE /sessions/current`, so a late
response cannot delete a replacement same-origin login. A server logout failure
is reported honestly while the app remains signed out locally. An
account change immediately cancels native work, stops playback, and clears all
in-memory account-scoped state.

The native account screen accepts only a valid HTTPS origin (for example,
`https://leerr.example.com`) and reports endpoint validation, rejected login,
protocol-response, saved-session, and post-login connection failures distinctly.
Connection status is display-only in native clients: upstream credentials and
configuration remain owned by the browser. Existing library paging and retry,
album-track retry, queue, seeking, source-versus-delivered quality, buffering,
playback error, and stream retry controls remain available with the shared API.

Manual race checks for the app-only model (which cannot be compiled by Linux
SwiftPM because it uses SwiftUI/AVFoundation): delay each login, restore,
connections, requests, resolve, editions, and album-tracks response; log out or
sign in as another account before releasing it; verify no old user, shared
state, discovery result, request, error, or playback is published. Also delay
`DELETE /sessions/current`, sign back into the same origin, and verify the new
bearer remains in Keychain. Finally, make connections/requests return
`upstream_auth` and verify Leerr sign-in and library access still succeed.

## Verification

Run `swift test` for contract decoding, pagination/query encoding, revoked
session versus `upstream_auth` errors, cancellation, and ticket URL validation,
plus all retained legacy tests. On Apple runners, generate/build both XcodeGen
targets and verify sign-in restoration/logout, library paging/search, shared
request discovery and confirmation, and original-audio seeking/range retries.
Then verify iOS interruption/route handling and lock-screen controls separately.
No native playback or Mac/iPhone UI claim should be made from a Linux orb.
