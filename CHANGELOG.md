# Changelog

## 0.3.0 (unreleased)

**Leerr now uses Plex instead of Jellyfin.** Library, playback, favourites,
playlists and "is it in my library yet" all come from a Plex Media Server; each
person signs in with their own Plex account on Plex's page (managed Home
profiles are linked by a Home member). Jellyfin support is gone: after
upgrading, an administrator enters the Plex server's HTTPS address under
Settings → Server and everyone signs in with Plex under Settings → Connections.
Saved Jellyfin sign-ins are deleted, and queues saved in browsers start empty.
API names changed accordingly (`/connections/plex/links`, `/admin/settings/plex`,
`plex*` fields and error codes).

The database upgrades itself from 0.2 (schema 3 to 4) on first start and keeps
a copy of the original next to it (`leerr.sqlite.v3-*.bak`).

**Docker deployments, before upgrading:**

- `compose.yaml` now pins the container network to `10.213.47.0/24`. The next
  `docker compose up` recreates the existing network, so a proxy on the host
  then connects from `10.213.47.1`. Set `LEERR_TRUST_PROXY=10.213.47.1` (or
  change the subnet and the trust value together). Otherwise every request
  fails with `https_required` while `/health` stays healthy.
- Settings can now live in `.env` (copy `.env.example`); values set in the
  shell still work. Point `LEERR_KEY_FILE` at your **existing** key, for
  example the old `./leerr-key`, ideally moved out of the checkout. Never
  generate a new key for an existing database.

Operator commands (`backup`, `restore`, `rotate-key`, `reset-password`) no
longer upgrade the database they open, so a backup made with 0.3 of a 0.2
database still opens in 0.2. See [rolling back](docs/deployment.md#rolling-back).

### Fixed

- Requests for an album Leerr adds to Lidarr now get the edition that was
  chosen. Lidarr used to monitor its own choice (the longest edition) and
  could refuse to import the requested one.
- Adding an album for a new artist no longer makes Lidarr unmonitor it after
  its first scan, and a partly imported album no longer counts as imported.
- Slow downloads are no longer reported as "nothing found" after a day:
  Leerr reads Lidarr's queue, and a stuck download needs attention instead.
- Searches are followed by their command id, so a Lidarr restart is noticed.
- Unconfirmed Lidarr changes become "needs attention" even while Lidarr is
  unreachable, so they can be retried and Lidarr can be switched.
- A brief Lidarr outage no longer replaces a failed request's reason, and
  "updated" times only move when something visible changes.
- Requesting an album Leerr thinks is imported re-checks Lidarr.
- Shutdown no longer hangs while someone is listening.
- The documented restore can no longer replay a stale write-ahead log over the
  backup: `leerr-operator restore` does it safely, also from a read-only
  location, and leaves nothing beside the backup.
- Restarts no longer add a scheduled backup each time (pushing older ones out):
  the next one is due a full period after the newest.
- A private CA's certificate problem now says so (and points to
  `NODE_EXTRA_CA_CERTS`) instead of "did not respond in time".
- Cover grids no longer use up the rate limit that playback needs.
- The Library page no longer shows the previous person's albums after
  sign-out, and refreshes when you come back to it.
- Saving only the Lidarr key no longer clears the root folder and profiles.
- Many player fixes: the old track stops at once, recovery works more than
  once, the seek bar no longer snaps back, real error messages, and the seek
  bar and Previous button on phones. Plex hears "stopped" for the track
  that was actually playing, also when signing out; Shuffle starts anywhere.
- Accessibility: focus on route changes and dialogs, announced player errors,
  page titles, contrast; keyboard focus survives tabs, queue reordering,
  menus and buttons that are busy, and is never hidden behind the player.

### Added

- Members can change their own password and withdraw their own requests.
- Known-device sign-in: strangers' guesses no longer lock out an account's
  owner, including everyone who shares a browser.
- Plex: sign-in on Plex's page, per-person libraries, managed Home profiles
  (linked by an administrator from Settings → Users, who can also unlink
  anyone), formats browsers cannot play (ALAC, AIFF) converted by Plex, and
  matching albums to requests by their MusicBrainz release. Each Plex account
  or profile belongs to one Leerr user, albums and tracks in Plex's trash are
  marked and never queued, and a requested album Plex has not matched is
  pointed at on the Requests page.
- Library sorting, "Recently added", artists, favourites and playlists.
- Queue: play next, add to queue, reorder, shuffle and repeat; the queue and
  position survive a reload.
- Playback is reported to Plex ("now playing", play counts, history).
- An installation-wide Last.fm key; suggestions from your own library.
- Artist pages by release type, and "New from your artists".
- Notifications to ntfy, Discord or a JSON webhook.
- An administrator status page; `/health` checks the database.
- Scheduled backups (`LEERR_BACKUP_DIR`); operator commands refuse to run beside a running server.
- A web app manifest and icons for "Add to Home Screen".
