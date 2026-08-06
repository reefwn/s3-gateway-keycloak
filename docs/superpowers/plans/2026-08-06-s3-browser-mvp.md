# S3 Browser MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver an environment-agnostic internal Next.js application that lets a Keycloak-authenticated user browse approved S3 buckets, perform role-gated streaming object operations, and write compliance audit events to PostgreSQL.

**Architecture:** A single Next.js App Router application serves the UI and same-origin route handlers. Server-only services validate deployment configuration, resolve a Keycloak session, authorize every request, lease a PostgreSQL-backed transfer slot, write append-only audit events, and proxy AWS SDK v3 streams. PostgreSQL holds audit and active-transfer records; external Keycloak, S3, IRSA, and ingress are configured only through environment variables.

**Tech Stack:** Next.js (Node runtime), React, TypeScript, shadcn/ui, Auth.js Keycloak provider, AWS SDK v3, Drizzle ORM with PostgreSQL, Zod, Bun, Vitest, Testing Library, Docker Compose.

## Global Constraints

- Source code contains no environment names, bucket names, AWS static credentials, or runtime configuration UI.
- All mutating operations are server-authorized, CSRF/origin-checked, audited before S3 invocation, and fail closed when audit persistence is unavailable.
- Every user receives exactly one configured global role: `readonly`, `readwrite`, or `admin`.
- Stream single objects up to 500 MiB; never buffer object bodies or ZIP archives in memory/disk.
- Limit each user to five concurrent uploads and five concurrent downloads through PostgreSQL-backed leases.
- The application never exposes OAuth tokens to browser JavaScript and must send no-store responses for authenticated data.
- No alerting, CloudTrail, backup administration, external deployment resources, or audit-log UI belongs in this plan.

---

### Task 1: Create the Bun/Next.js development foundation

**Files:**

- Replace: `package.json`, `bun.lock`
- Create: `next.config.ts`, `tsconfig.json`, `postcss.config.mjs`, `components.json`, `vitest.config.ts`, `tests/setup.ts`, `.gitignore`, `.dockerignore`, `.env.example`, `Dockerfile`, `compose.yaml`, `README.md`
- Create: `app/layout.tsx`, `app/globals.css`, `app/page.tsx`

**Interfaces:**

- Produces `bun dev`, `bun test`, `bun run lint`, `bun run typecheck`, and `bun run build` commands.
- Produces a Docker development service on port 3000 and a PostgreSQL service on port 5432.

- [ ] **Step 1: Scaffold a TypeScript Next.js App Router application with Bun**

  Use `bunx create-next-app@latest` with TypeScript, App Router, Tailwind, ESLint, `src/` disabled, and Bun as the package manager. Replace the starter package metadata with scripts for `dev`, `build`, `start`, `lint`, `typecheck`, `test`, `test:watch`, `db:generate`, `db:migrate`, and `db:studio`.

- [ ] **Step 2: Install runtime and test dependencies**

  Install `@aws-sdk/client-s3`, `@aws-sdk/lib-storage`, `@auth/core`, `next-auth`, `drizzle-orm`, `pg`, `zod`, `archiver`, `server-only`, `lucide-react`, `class-variance-authority`, `clsx`, `tailwind-merge`, and `tw-animate-css`. Install development dependencies `drizzle-kit`, `vitest`, `@vitejs/plugin-react`, `jsdom`, `@testing-library/react`, `@testing-library/user-event`, `@testing-library/jest-dom`, and matching type packages.

- [ ] **Step 3: Configure shadcn/ui and install base components**

  Initialise shadcn with neutral styling and add `alert-dialog`, `badge`, `button`, `card`, `dialog`, `input`, `label`, `separator`, `table`, and `tooltip`. Keep generated primitives under `components/ui/`.

- [ ] **Step 4: Add reproducible local runtime configuration**

  Add `.env.example` with every required non-secret application variable and explicitly named local-development values. Add Docker Compose services `app` and `postgres`; `app` must run `bun dev` with the source mounted and depend on a healthy Postgres service. Use a named local volume for PostgreSQL data. Add a Bun Dockerfile that runs as a non-root user.

- [ ] **Step 5: Add minimal UI and developer documentation**

  Replace starter UI with a neutral application shell. Document local setup (`cp .env.example .env`, `docker compose up`, migration command, test/typecheck/lint/build commands) and state that Keycloak/S3 values must be supplied for a real deployment.

- [ ] **Step 6: Verify the foundation**

  Run `bun test`, `bun run lint`, `bun run typecheck`, and `bun run build`. Start `docker compose up --build` and verify `/api/health` after Task 4 creates it.

### Task 2: Implement and test validated runtime configuration and domain policies

**Files:**

- Create: `lib/config.ts`, `lib/config.test.ts`, `lib/auth/roles.ts`, `lib/auth/roles.test.ts`, `lib/objects/keys.ts`, `lib/objects/keys.test.ts`

**Interfaces:**

- `loadConfig(env?: Record<string, string | undefined>): AppConfig` returns validated immutable configuration or throws a helpful startup error.
- `resolveRole(claimValue: unknown, mapping: RoleMapping): AppRole | null` returns one role only.
- `assertSafeObjectKey(key: string): string` rejects invalid user-created keys without interpreting them as filesystem paths.

- [ ] **Step 1: Write failing configuration tests**

  Cover a valid deployment config, missing database URL, invalid/duplicate bucket names, an HTTP origin outside local development, a malformed role mapping, and transfer/archive limits below one. Assert the specific configuration field causing failure.

- [ ] **Step 2: Run configuration tests and confirm expected failure**

  Run `bun vitest run lib/config.test.ts`; the failure must identify missing `loadConfig` rather than a test setup error.

- [ ] **Step 3: Implement the Zod-backed configuration contract**

  Parse PostgreSQL URL, Keycloak issuer/client fields, application origin, comma-separated bucket allowlist, role claim path/mapping JSON, S3 region, 500 MiB object limit, and configurable archive/transfer limits. Reject duplicate buckets, static AWS credential variables, and invalid origin/limits. Export a cached server-only configuration accessor.

- [ ] **Step 4: Verify configuration tests pass**

  Run `bun vitest run lib/config.test.ts` and confirm all listed cases pass.

- [ ] **Step 5: Write failing role and object-key tests**

  Test absent/ambiguous role values, all valid roles, safe Unicode keys, empty keys, and control-character rejection. Existing S3 keys are treated as opaque strings; only user-created keys are validated.

- [ ] **Step 6: Implement and verify role/key domain functions**

  Implement the smallest pure functions satisfying the tests. Run `bun vitest run lib/auth/roles.test.ts lib/objects/keys.test.ts` and then the whole unit suite.

### Task 3: Add PostgreSQL schema, audit repository, and global transfer leasing

**Files:**

- Create: `db/client.ts`, `db/schema.ts`, `db/migrations/0000_initial.sql`, `db/audit.ts`, `db/audit.test.ts`, `db/transfers.ts`, `db/transfers.test.ts`, `drizzle.config.ts`

**Interfaces:**

- `writeAuditAttempt(input: AuditAttempt): Promise<AuditEvent>` and `writeAuditOutcome(input: AuditOutcome): Promise<AuditEvent>` insert immutable records.
- `leaseTransfer(input: TransferLeaseInput): Promise<TransferLease>` atomically permits/denies a user’s upload/download lease; `releaseTransfer(id: string): Promise<void>` ends it.
- `cleanupExpiredTransfers(now: Date): Promise<number>` removes stale leases.

- [ ] **Step 1: Write failing repository behavior tests using a PostgreSQL test database**

  Test that audit attempts/outcomes are separate immutable rows, audit fields include actor/resource/correlation/outcome details, six same-kind leases are denied after five active leases, upload and download counts are independent, releasing a lease permits a new one, and expired leases no longer count.

- [ ] **Step 2: Run the repository tests and confirm expected failure**

  Start local PostgreSQL with Docker Compose and run `bun vitest run db/audit.test.ts db/transfers.test.ts`; expected failure is missing repository exports.

- [ ] **Step 3: Implement Drizzle schema and SQL migration**

  Create `audit_events` with UUID ID, append-only event kind, timestamps, immutable actor snapshot, request correlation fields, bucket/key/prefix, source metadata, operation, and outcome/error details. Create `active_transfers` with a composite index on actor/type/expiry. Add the migration and generation scripts.

- [ ] **Step 4: Implement repositories with transactional lease acquisition**

  Use a database transaction and locking-safe count/insert strategy so five is enforced across replicas. Do not provide update/delete methods for audit events. Keep DB connection code server-only.

- [ ] **Step 5: Verify repositories against PostgreSQL**

  Apply migrations, run targeted tests, then `bun test`. Inspect the migration for missing indexes and audit mutability paths.

### Task 4: Implement Keycloak session boundary, authorization guard, audit wrapper, and health endpoint

**Files:**

- Create: `auth.ts`, `app/api/auth/[...nextauth]/route.ts`, `lib/auth/session.ts`, `lib/auth/session.test.ts`, `lib/security/origin.ts`, `lib/security/origin.test.ts`, `lib/operations/with-audit.ts`, `lib/operations/with-audit.test.ts`, `app/api/health/route.ts`, `app/api/health/route.test.ts`

**Interfaces:**

- `getCurrentActor(): Promise<Actor>` validates the server session and returns `sub`, username/email snapshot, and exactly one role.
- `requireCapability(capability: Capability): Promise<Actor>` returns an actor or throws a generic unauthorised/not-found response.
- `assertTrustedMutationOrigin(request: Request): void` rejects cross-origin state changes.
- `runAuditedOperation(context, operation)` writes an attempt before operation and an outcome afterward; it refuses the operation if attempt persistence fails.

- [ ] **Step 1: Write failing auth and authorization tests**

  Test unauthenticated requests, role capability matrix, ambiguous mappings, actor snapshots, and generic inaccessible-resource errors. Keep the role matrix as pure code; mock only the Auth.js session boundary.

- [ ] **Step 2: Verify red state and implement Auth.js integration**

  Run the tests, verify missing exports, then configure the Keycloak provider with JWT session strategy, secure cookies, and server-only callbacks that map the configured claim to exactly one role. Add `getCurrentActor` and `requireCapability`.

- [ ] **Step 3: Write and implement origin/audit wrapper tests**

  Tests must prove same-origin mutation passes, other origin fails, audit attempt failure prevents the operation, and success/failure operation outcomes append the correct events. Implement the origin guard and wrapper after confirming red tests.

- [ ] **Step 4: Add and test health endpoint**

  Make `GET /api/health` return only `{ status: "ok" }` when configuration and PostgreSQL connectivity succeed, otherwise a generic 503. It must never query S3 or create audit events.

- [ ] **Step 5: Run the Task 4 verification suite**

  Run all `lib/auth`, `lib/security`, `lib/operations`, and health tests plus `bun run typecheck`.

### Task 5: Implement and test the S3 streaming operation service

**Files:**

- Create: `lib/s3/client.ts`, `lib/s3/service.ts`, `lib/s3/service.test.ts`, `lib/s3/types.ts`, `lib/zip/prefix-download.ts`, `lib/zip/prefix-download.test.ts`

**Interfaces:**

- `listObjects(bucket, prefix, continuationToken)` returns normalized paginated S3 list data.
- `getObjectStream(bucket, key)` returns body stream and safe download headers.
- `putObjectStream(bucket, key, body, contentType, contentLength)` streams a validated object to S3.
- `deleteObject(bucket, key)` and `createPrefixMarker(bucket, prefix)` call corresponding S3 actions.
- `streamPrefixZip(bucket, prefix)` produces a streamed archive or rejects an over-limit prefix.

- [ ] **Step 1: Write failing service tests with AWS client fakes**

  Cover bucket allowlist enforcement, pagination normalization, attachment/no-sniff headers, 500 MiB rejection before S3 invocation, forbidden metadata/ACL inputs, exact key replacement behavior, prefix marker naming, and S3 error normalization. Fakes may replace AWS network calls but tests assert service behavior and command inputs.

- [ ] **Step 2: Run the S3 tests and verify red state**

  Run `bun vitest run lib/s3/service.test.ts`; expected failures must be missing service functions.

- [ ] **Step 3: Implement the S3 service with IRSA-only client creation**

  Instantiate `S3Client` with region only; do not pass credentials. Use SDK commands and Web/Node stream adapters without buffering. Enforce allowlist and user-created-key rules before creating commands.

- [ ] **Step 4: Write failing prefix ZIP tests and implement streaming archive limits**

  Test an archive succeeds under 1,000 objects/2 GiB and rejects before response for count/size overflow. Implement sequential S3 streams piped into `archiver`; do not write files locally.

- [ ] **Step 5: Verify the S3 service suite**

  Run targeted S3/ZIP tests, full tests, and typecheck.

### Task 6: Implement audited API routes for browser operations

**Files:**

- Create: `app/api/buckets/route.ts`, `app/api/buckets/route.test.ts`, `app/api/objects/[bucket]/route.ts`, `app/api/objects/[bucket]/route.test.ts`, `app/api/objects/[bucket]/[...key]/route.ts`, `app/api/objects/[bucket]/[...key]/route.test.ts`, `app/api/prefix-download/[bucket]/route.ts`, `app/api/prefix-download/[bucket]/route.test.ts`, `app/api/transfers/[id]/route.ts`

**Interfaces:**

- `GET /api/buckets` exposes only configured buckets to authenticated roles.
- Object routes implement paginated list, upload, stream download, explicit overwrite, marker creation, and admin-only exact-key delete.
- `GET /api/prefix-download/:bucket?prefix=` streams one audited ZIP download.

- [ ] **Step 1: Write failing route tests for role and security boundaries**

  Test generic responses for unconfigured/inaccessible buckets, readonly mutation denial, readwrite delete denial, origin failure, no-store headers, and no calls to S3 when audit attempt fails.

- [ ] **Step 2: Implement bucket/list/upload/prefix routes and verify green**

  Use `requireCapability`, `assertTrustedMutationOrigin`, `runAuditedOperation`, and S3 service functions. Acquire/release upload transfer leases in `try/finally`; return 429 when capped. Validate `Content-Length` and stream FormData file bodies.

- [ ] **Step 3: Write failing download/delete/ZIP tests**

  Test attachment streaming/no-store, per-type download leases, admin exact-key confirmation header/body matching, explicit overwrite signal, archive limit errors, and audit outcomes.

- [ ] **Step 4: Implement the remaining routes and verify green**

  Add streaming response handlers with abort cleanup and ensure every error is generic to the browser while the outcome event records the error class.

- [ ] **Step 5: Run the complete API suite**

  Run all route tests and `bun run typecheck`.

### Task 7: Build the shadcn browser UI and interaction tests

**Files:**

- Create: `components/s3-browser.tsx`, `components/bucket-list.tsx`, `components/object-table.tsx`, `components/upload-dialog.tsx`, `components/create-folder-dialog.tsx`, `components/delete-object-dialog.tsx`, `components/prefix-download-button.tsx`, `components/session-menu.tsx`
- Create: `components/s3-browser.test.tsx`, `components/delete-object-dialog.test.tsx`, `components/upload-dialog.test.tsx`
- Modify: `app/page.tsx`, `app/layout.tsx`, `app/globals.css`

**Interfaces:**

- `S3Browser` receives an `Actor` and initial bucket list and renders role-gated controls.
- Mutations use same-origin API calls with explicit confirmation/origin safeguards; the server remains authoritative.

- [ ] **Step 1: Write failing component tests**

  Cover readonly control hiding, readwrite upload/folder visibility, admin delete visibility, exact-key delete confirmation disabled until matching, overwrite warning, 500 MiB client-side feedback, and generic inaccessible error copy.

- [ ] **Step 2: Implement the server-rendered page and browser shell**

  Redirect unauthenticated users to Keycloak sign-in. Render only user-allowed bucket controls and fetch listing data through server-side service/API boundary. Use shadcn primitives and accessible labels.

- [ ] **Step 3: Implement dialogs and streaming actions**

  Implement single-file upload, marker creation, typed delete confirmation, explicit replace confirmation, object download links, and prefix ZIP download. Do not add previews, bulk mutation, or client token handling.

- [ ] **Step 4: Verify UI tests and static accessibility basics**

  Run component tests, lint, typecheck, and build. Confirm dialogs use labels/descriptions and keyboard-accessible shadcn controls.

### Task 8: Complete operational documentation and end-to-end MVP verification

**Files:**

- Modify: `README.md`, `.env.example`, `docs/s3-browser-tool-requirements.md`
- Create: `docs/mvp-verification.md`

**Interfaces:**

- Documents local Bun/Docker/PostgreSQL startup and all application-level configuration values.
- Provides reproducible verification commands and expected results.

- [ ] **Step 1: Document configuration and local developer workflows**

  List each required variable, explain mock-free local Keycloak/S3 prerequisites, explain migration commands, and identify which requirements are deployment-owned rather than application-owned.

- [ ] **Step 2: Run automated verification**

  Run `bun test`, `bun run lint`, `bun run typecheck`, and `bun run build`. Record commands, exit codes, and test totals in the verification document.

- [ ] **Step 3: Verify Docker development runtime**

  Run `docker compose up --build -d`, wait for Postgres health, run migrations in the app container, and verify `/api/health` returns 200. Capture clean shutdown instructions.

- [ ] **Step 4: Perform requirements-to-evidence audit**

  Re-read `docs/s3-browser-tool-requirements.md`, map every application-owned v1 requirement to a source file and test/runtime evidence, and list only external prerequisites as intentionally outside scope.
