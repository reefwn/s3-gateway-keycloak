# S3 Browser

Internal, browser-only S3 object management for approved buckets. The single Next.js application authenticates with Keycloak, authorizes a global role, proxies S3 with IRSA credentials, and records application audit events in PostgreSQL.

## Local development

1. Copy the local configuration template: `cp .env.example .env`.
2. Start the app, app PostgreSQL, Keycloak, and persistent local Floci S3: `docker compose up --build`.
3. Apply database migrations from another terminal: `docker compose exec app bun --env-file=.env run db:migrate`.
4. Check readiness: `curl http://localhost:3000/api/health`.

The local app listens on `http://localhost:3000`; PostgreSQL is published on `localhost:5433` to avoid a common local 5432 conflict. Floci’s S3-compatible endpoint is `http://localhost:4566`. The root page redirects to Keycloak, so a working Keycloak client and role mapping are required for interactive use.

Compose starts Floci with persistent object storage and runs a one-shot initializer before the app. The initializer creates every bucket in `S3_ALLOWED_BUCKETS`, so deployment-local configuration can supply any number of approved buckets without changing source code. Floci object data remains in the `floci_data` Docker volume across normal restarts.

Keycloak’s local admin console is `http://keycloak.localhost:8080/admin`. Sign in with username `local-keycloak-admin` and password `local-keycloak-admin-password`.

Use the following local fixture accounts to verify application roles:

| Username | Password | Application role |
| --- | --- | --- |
| `s3-readonly` | `local-readonly-password` | `readonly` |
| `s3-readwrite` | `local-readwrite-password` | `readwrite` |
| `s3-admin` | `local-admin-password` | `admin` |

The Keycloak admin and fixture-account credentials, plus the values in `.env.example`, are development fixtures only and must never be deployed.

To reset local identity state only (the Keycloak realm, users, and Keycloak PostgreSQL data), run `docker compose down`, then delete only the Keycloak volume with `docker volume rm s3-gateway-keycloak_keycloak_postgres_data`, and restart Compose. This preserves the application PostgreSQL database. Do not use `docker compose down -v` for an identity-only reset: it deletes both the Keycloak and application PostgreSQL volumes.

To reset local S3 object state only, run `docker compose down`, delete just the Floci volume with `docker volume rm s3-gateway-keycloak_floci_data`, and restart Compose. Do not use `docker compose down -v` for this: it also deletes the application and Keycloak PostgreSQL volumes.

## Commands

- `bun run dev` — run the Next.js development server with Webpack.
- `bun run test` — run Vitest (requires the local PostgreSQL service for database integration tests).
- `bun run test:s3-integration` — run the real Floci S3 integration test (requires `docker compose up -d`; it always targets local Floci and never AWS).
- `bun run lint` — run ESLint.
- `bun run typecheck` — run TypeScript validation.
- `bun run build` — create the standalone Webpack production build.
- `bun --env-file=.env run db:migrate` — apply Drizzle migrations locally.

## Deployment configuration

All configuration is deployment-supplied; source code does not name environments or buckets. Required variables are listed in `.env.example`:

- Keycloak issuer/client/secret and a 32+ character `NEXTAUTH_SECRET`.
- An exact `NEXTAUTH_URL` origin (HTTPS except local development).
- PostgreSQL `DATABASE_URL`.
- S3 region, comma-separated bucket allowlist, Keycloak claim path, and role mapping JSON.
- Optional object, transfer, and archive limits; defaults are 500 MiB, five uploads/downloads per actor, 1,000 objects, and 2 GiB uncompressed archive size.

Static AWS credentials are deliberately rejected at startup. The deployed service must use the AWS SDK default IRSA credential chain.

## Kubernetes deployment

The Helm chart in `charts/s3-browser` deploys the application, a single
PostgreSQL StatefulSet, a migration gate, and a retained PostgreSQL PVC. It
does not create Keycloak, HTTPS ingress/certificates, S3 buckets or policies,
an IRSA IAM role, storage classes/PVs, backups, or Kubernetes Secrets.

Build and publish the production image before installing the chart:

```sh
docker build -t reefwn/s3-gateway-keycloak:v1.0.1 .
docker push reefwn/s3-gateway-keycloak:v1.0.1
sh scripts/verify-production-image.sh
```

The chart requires a pre-created secret. Keep every value in a protected
secret-management workflow or a local, access-restricted file; do not add
these files to Git. The secret must include `POSTGRES_DB`, `POSTGRES_USER`,
`POSTGRES_PASSWORD`, `DATABASE_URL`, `NEXTAUTH_SECRET`, and
`KEYCLOAK_CLIENT_SECRET`.

For example, create the files with your approved secret-management tooling,
then create the Kubernetes Secret:

```sh
kubectl create namespace s3-browser
kubectl -n s3-browser create secret generic deployment-secrets \
  --from-literal=POSTGRES_DB=s3_browser \
  --from-literal=POSTGRES_USER=s3_browser \
  --from-file=POSTGRES_PASSWORD=./postgres-password \
  --from-file=DATABASE_URL=./database-url \
  --from-file=NEXTAUTH_SECRET=./nextauth-secret \
  --from-file=KEYCLOAK_CLIENT_SECRET=./keycloak-client-secret
```

`database-url` must be a complete PostgreSQL URL using the release database
service. For a release named `s3-browser` in the `s3-browser` namespace, the
host is `s3-browser-postgresql.s3-browser.svc.cluster.local:5432`. Percent
encode reserved password characters in the URL; the chart intentionally does
not construct `DATABASE_URL` from separate fields.

Copy the credential-free example and replace its representative URLs, bucket
allowlist, storage class, IRSA annotation, and optional ingress values:

```sh
cp charts/s3-browser/values-production.example.yaml values-production.yaml
helm upgrade --install s3-browser ./charts/s3-browser \
  --namespace s3-browser \
  --create-namespace \
  --wait \
  --timeout 10m \
  --values values-production.yaml
```

Each new application pod runs `bun run db:migrate` in an init container before
the application container can start. Kubernetes retries the init container
until PostgreSQL is reachable and migration succeeds. `--wait --timeout 10m`
causes Helm to return failure if the new pod cannot become ready. Investigate a
blocked migration with the init-container logs:

```sh
kubectl -n s3-browser get pods -l app.kubernetes.io/instance=s3-browser
kubectl -n s3-browser logs deployment/s3-browser -c migrate
```

PostgreSQL PVCs are retained across upgrades, scale-down, and Helm uninstall.
Review and document any data deletion outside this application before manually
removing the retained PVC.

## Application behavior

- `readonly` can browse and download; `readwrite` can also upload and create prefix markers; `admin` can additionally delete individual objects after typing the exact key.
- Uploads and downloads stream through the server. Prefix downloads stream a ZIP archive and are bounded by the configured object/size limits.
- All S3 actions write an append-only attempt event and outcome event to PostgreSQL. If the attempt cannot be stored, the action is denied.
- Authenticated pages, APIs, and downloads use `Cache-Control: no-store`; object downloads are attachment-only and `nosniff`.

## Operator index interface

The application-owned sign-in page starts the Keycloak flow; Keycloak continues to host credential entry. After authentication, the Operator index keeps daily object operations in one workspace:

- Select an approved bucket from the persistent bucket index, then navigate prefixes with breadcrumbs or the parent action.
- Use the finder to filter the current prefix locally by folder or object name. Folder rows always precede object rows.
- Role-gated upload, prefix creation, and deletion controls appear only after a bucket is selected. The same server-side authorization rules remain authoritative.
- Refresh the current prefix or download it as a ZIP without leaving the workspace. Browser request failures show generic retry guidance instead of transport details.

For a local visual check, authenticate with one of the fixture accounts above, select a bucket, and verify the role-specific controls and object navigation. Manual upload testing should be performed in a normal browser session; automated Chrome-debug sessions can terminate renderer file-upload requests before they reach the application.

Infrastructure-managed prerequisites—HTTPS/internal ingress, IRSA role and least-privilege bucket policy, managed PostgreSQL backup/recovery, Keycloak client administration, and audit retention review—remain outside this application repository.
