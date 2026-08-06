# S3 Browser

Internal, browser-only S3 object management for approved buckets. The single Next.js application authenticates with Keycloak, authorizes a global role, proxies S3 with IRSA credentials, and records application audit events in PostgreSQL.

## Local development

1. Copy the local configuration template: `cp .env.example .env`.
2. Start the app and PostgreSQL: `docker compose up --build`.
3. Apply database migrations from another terminal: `docker compose exec app bun --env-file=.env run db:migrate`.
4. Check readiness: `curl http://localhost:3000/api/health`.

The local app listens on `http://localhost:3000`; PostgreSQL is published on `localhost:5433` to avoid a common local 5432 conflict. The root page redirects to Keycloak, so a working Keycloak client and role mapping are required for interactive use.

## Commands

- `bun run dev` — run the Next.js development server with Webpack.
- `bun run test` — run Vitest (requires the local PostgreSQL service for database integration tests).
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

## Application behavior

- `readonly` can browse and download; `readwrite` can also upload and create prefix markers; `admin` can additionally delete individual objects after typing the exact key.
- Uploads and downloads stream through the server. Prefix downloads stream a ZIP archive and are bounded by the configured object/size limits.
- All S3 actions write an append-only attempt event and outcome event to PostgreSQL. If the attempt cannot be stored, the action is denied.
- Authenticated pages, APIs, and downloads use `Cache-Control: no-store`; object downloads are attachment-only and `nosniff`.

Infrastructure-managed prerequisites—HTTPS/internal ingress, IRSA role and least-privilege bucket policy, managed PostgreSQL backup/recovery, Keycloak client administration, and audit retention review—remain outside this application repository.
