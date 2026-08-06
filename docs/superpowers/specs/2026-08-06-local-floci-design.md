# Local Floci S3 Design

## Purpose

Run Floci as the local S3-compatible backend for both browser-based manual
development and automated integration tests. This is a local-development
facility only; deployed environments continue to use AWS S3 through IRSA and
the AWS SDK default credential chain.

## Architecture

Docker Compose will add three local-only services:

- `floci`, using the official `floci/floci` image and publishing port 4566.
- `floci-init`, a one-shot AWS CLI job that waits for Floci then creates every
  comma-separated bucket in `S3_ALLOWED_BUCKETS` idempotently.
- Existing `app`, updated to wait for `floci-init` to complete successfully
  before starting in local Compose development.

Floci state persists in a dedicated named volume so manual objects survive
container restarts. Removing only that volume resets local S3 state; the
application and Keycloak PostgreSQL volumes remain intact.

## Configuration and Security Boundary

The app receives three new optional S3 configuration values:

- `S3_ENDPOINT_URL` — local S3-compatible endpoint, set to
  `http://floci:4566` in the app container.
- `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` — local emulator credentials.

All three values are accepted only when `APP_ENVIRONMENT=local`. In local
mode, the S3 client uses these static test credentials, the explicit endpoint,
and path-style S3 addressing. Outside local mode, supplying any of the three
values fails configuration validation. The client uses no endpoint override or
static credentials outside local mode, preserving the existing IRSA-only
production behavior.

The existing global AWS credential environment variables remain forbidden in
all environments. Local emulator credentials use separate, application-scoped
names so they cannot be accidentally consumed by unrelated SDK clients.

## Bucket Initialization

`floci-init` receives `S3_ALLOWED_BUCKETS`, local emulator endpoint, region,
and non-production credentials. It splits the allowlist, skips blank entries,
and runs idempotent `aws s3api create-bucket` commands. A bucket that already
exists is treated as success. The init job has no host port and exits once all
configured buckets exist.

The application retains its exact allowlist validation. It can operate only on
the same bucket inventory that Floci provisions; no bucket is accepted from
the browser or created by the application itself.

## Automated Integration Tests

The test configuration points the AWS SDK to Floci through the same local-only
configuration path. S3 integration tests use unique, test-owned object keys in
one configured bucket and remove only their own objects after each test. Tests
do not create arbitrary production-style buckets or depend on AWS credentials.

The unit suite remains runnable without Docker. The Floci-backed S3 integration
suite requires the Compose stack and is documented separately from unit tests.

## Verification

1. Validate configuration rejects local endpoint/credentials outside local
   development and preserves IRSA behavior when local values are absent.
2. Start Compose and verify Floci readiness plus successful `floci-init` exit.
3. Confirm each configured allowlisted bucket exists through the AWS CLI.
4. Run S3 service integration tests against Floci for list, upload, download,
   conditional overwrite, delete, and prefix archive behavior.
5. Confirm browser manual upload/download works through the existing app.

## Scope

This change does not alter AWS deployment configuration, IRSA, production
bucket permissions, S3 operation authorization, Keycloak, or audit behavior.
It adds only local endpoint selection, local fixture credentials, bucket
initialization, and Floci-backed test coverage.
