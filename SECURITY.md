# Security

Leerr holds people's passwords (as Argon2id hashes), their Jellyfin tokens and
the installation's Lidarr key (encrypted), so security reports are welcome.

## Reporting

Please report vulnerabilities privately through GitHub's "Report a
vulnerability" (Security → Advisories) on this repository rather than in a
public issue. Include what an attacker needs (network position, an account,
which role) and what they gain.

## Scope

The security model is described in [docs/architecture.md](docs/architecture.md#security-model).
Especially interesting: anything that lets one household member see another's
library, requests or credentials; ways around the Host/Origin/HTTPS checks,
CSRF protection, sign-in throttling or revocation; stream tickets that outlive
their session; and upstream responses that can make Leerr misbehave.

Out of scope: an administrator configuring Jellyfin, Lidarr or notification
addresses that point at other services (administrators are trusted with that),
and anything that needs the encryption key file or the database.
