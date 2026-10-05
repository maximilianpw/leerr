# Security

Leerr holds people's passwords (as Argon2id hashes), their Plex tokens and the
installation's Lidarr key (encrypted), so security reports are welcome. A
stored plex.tv account token is not limited to Leerr's server. For everyone who
links a full Plex account (the server's owner, people the server is shared
with, Plex Home members) it can do whatever that account can, including
running any Plex server the account owns; for the server's owner even the
server token is that same account token. A managed profile's token is limited
to that profile, but in a Plex Home whose administrator has no Plex PIN, any
Home member's or profile's token can switch to the administrator (see
docs/deployment.md). Treat the database and key file like the Plex passwords of
everyone linked.

## Reporting

Please report vulnerabilities privately through GitHub's "Report a
vulnerability" (Security → Advisories) on this repository rather than in a
public issue. Include what an attacker needs (network position, an account,
which role) and what they gain.

## Scope

The security model is described in [docs/architecture.md](docs/architecture.md#security-model).
Especially interesting: anything that lets one household member see another's
library, requests or credentials; finishing someone else's Plex sign-in or
linking a Plex Home profile that is not a managed one; ways around the
Host/Origin/HTTPS checks, CSRF protection, sign-in throttling or revocation;
stream tickets that outlive their session; and upstream responses that can
make Leerr misbehave.

Out of scope: an administrator configuring Plex, Lidarr or notification
addresses that point at other services (administrators are trusted with that),
and anything that needs the encryption key file or the database.
