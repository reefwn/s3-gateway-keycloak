# Local Keycloak Integration Design

## Purpose

Provide a reproducible local Keycloak service for manually verifying the S3
Browser’s Keycloak BFF flow. This is development-only infrastructure and does
not change the deployment model: production identity configuration remains
DevOps-supplied.

## Topology

Docker Compose will run a Keycloak 26 service with a PostgreSQL-backed
development database owned by Keycloak. It publishes port 8080 and uses the
public issuer `http://keycloak.localhost:8080/realms/internal`.

The `keycloak.localhost` name is deliberate. Browsers resolve the `.localhost`
domain to the host loopback address, reaching Keycloak through its published
port. The Compose network also aliases the Keycloak service by that same name,
so the Next.js app can use the exact issuer URL for server-side OIDC discovery,
token exchange, and browser redirects.

The existing app service will wait for PostgreSQL and Keycloak health checks.
The local app configuration will use this issuer; deployment configuration is
unchanged.

## Imported Realm

A versioned realm import, mounted read-only into Keycloak, creates the
`internal` realm at first startup. It contains a confidential OIDC client:

- Client ID: `s3-browser`
- Client secret: the local development value already used by `.env`
- Standard flow: enabled
- Redirect URI: `http://localhost:3000/api/auth/callback/keycloak`
- Web origin: `http://localhost:3000`

The client provides the exact roles mapped by the app configuration:
`s3-browser-admin`, `s3-browser-readwrite`, and `s3-browser-readonly`.

## Seeded Development Users

The imported realm creates three enabled, non-temporary development users. Each
has a single client role and cannot acquire application permissions from the
other two roles:

| User | Client role | Password |
|---|---|---|
| `s3-readonly` | `s3-browser-readonly` | `local-readonly-password` |
| `s3-readwrite` | `s3-browser-readwrite` | `local-readwrite-password` |
| `s3-admin` | `s3-browser-admin` | `local-admin-password` |

These deliberately public, local-only credentials are test fixtures; they
must never be used outside the Compose environment. The Keycloak admin console
will use a separate local-only administrator credential.

## Operational Behavior

`docker compose up` creates/imports the realm on a fresh local Keycloak data
volume. Recreating the container preserves that volume and does not overwrite
manual local Keycloak changes; removing the named Keycloak volume intentionally
resets the local identity state and reimports the realm on next start.

The README will document startup, the admin console URL, all development test
accounts, and the reset command. It will also state that neither the test
accounts nor their secrets belong in deployment configuration.

## Verification

1. Start the Compose stack and wait for the Keycloak health check.
2. Fetch the realm OIDC discovery document at the configured issuer.
3. Confirm the app health endpoint remains available.
4. Open `http://localhost:3000`, complete Keycloak login using each test user,
   and confirm the app receives the matching role.
5. Run the existing automated test, lint, typecheck, and build commands.

## Scope and Safety

This addition is limited to local development Compose configuration and
documentation. It does not provision S3, AWS credentials, production
Keycloak, production databases, ingress, or any deployment resources.
