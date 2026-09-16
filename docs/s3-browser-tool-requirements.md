# S3 Browser Tool — Agreed v1 Requirements

> Status: **Agreed design — ready for implementation planning**  
> Owner: **DevOps / platform team**  
> Updated: 2026-08-06

## 1. Purpose and Decision

TH developers do not have direct AWS Console or CLI access to S3. SG's
custom MinIO gateway cannot be adopted in TH: upstream gateway mode was
removed, and the old gateway-capable build cannot initialize against
`ap-southeast-7`. Forking it would create an unsupported long-term
maintenance burden. Filestash was also rejected because the open-source
edition does not provide the required Keycloak SSO and authorization model
without extra proxy and custom authorization components.

**Decision:** build a small, internal, browser-only S3 management tool. It
will be one environment-agnostic Next.js application, deployed separately by
DevOps with deployment-specific configuration. It is not a replacement for
AWS S3 administration or a general S3 proxy API.

## 2. Scope

### Goals

- Let authenticated internal users browse, upload, download, and delete
  objects in an explicit, deployment-supplied S3 bucket allowlist in
  `ap-southeast-7`.
- Use Keycloak SSO and three global permission levels: `admin`, `readwrite`,
  and `readonly`.
- Access S3 only through IRSA. Static AWS credentials are prohibited.
- Provide a compliance-grade, application-owned audit trail in PostgreSQL.
- Run as an internal-only HTTPS service behind the approved ingress.

### Non-goals

- Per-bucket or per-prefix roles. Each user has exactly one role across every
  bucket configured for that deployment.
- Bucket creation/deletion, lifecycle management, object-version UI,
  recursive folder deletion, copy/move/rename, multi-cloud backends, or a
  programmatic/public API.
- Bulk upload or bulk delete. Prefix download is the one bulk operation in
  scope.
- Malware scanning, thumbnails, video processing, or an audit-log UI/export
  facility. The narrowly constrained preview described below is the only
  inline rendering in scope.
- Application implementation of CloudTrail, alert routing, on-call
  integration, database backup, retention review, or manual audit deletion.
  These are external platform/compliance processes.

## 3. Product and Authorization Model

### Roles

| Role | Allowed actions in every configured bucket |
|---|---|
| `readonly` | List and download objects/prefixes |
| `readwrite` | `readonly` actions; upload objects and create prefix markers |
| `admin` | `readwrite` actions; delete individual objects |

- The application accepts exactly one mapped role. Missing, invalid, or
  conflicting mappings deny access.
- DevOps configures the Keycloak claim and the mapping of claim values/groups
  to these roles. The configuration is deployment-controlled, not editable in
  the UI or through an application API.
- Authorization is checked server-side on every operation. Client-supplied
  roles are never trusted.
- A role change must take effect within five minutes. Use short-lived access
  tokens, check authorization on every request, and retain a Keycloak admin
  procedure to revoke sessions for immediate emergency removal.

### Authentication and session handling

- Use a dedicated, confidential Keycloak OIDC client for each deployment,
  with Authorization Code + PKCE. Do not reuse MinIO client credentials.
- The Next.js server acts as the backend-for-frontend: it performs OIDC and
  stores session state in encrypted, `HttpOnly`, `Secure`, `SameSite` cookies.
  Browser JavaScript must not receive OAuth tokens.
- Use a 30-minute idle timeout and an eight-hour maximum session lifetime,
  subject to stricter Keycloak expiry.
- The application audits successful sign-ins, sign-outs, callback failures,
  and authorization denials. Keycloak remains responsible for failed
  credential-entry audit events that never reach the application.

## 4. Object Operations and UI

The UI is a same-origin, functional browser: bucket list → paginated object
and prefix list → object actions. It is browser-only; its route handlers are
not a supported external API.

- **List:** use S3 `ListObjectsV2` with prefix navigation and pagination.
  Inaccessible resources return a generic “not found or not permitted”
  response, without exposing bucket/key existence.
- **Search:** search the current approved bucket by case-insensitive full key,
  including nested objects. Bound each search by deployment configuration for
  maximum results and maximum S3 list pages; mark results as partial when a
  bound is reached. Search does not expose an arbitrary-bucket endpoint.
- **Download:** stream a single object through the application. Serve it as an
  attachment with `X-Content-Type-Options: nosniff`. No public, presigned, or
  otherwise unauthenticated download URL is provided.
- **Preview:** an authenticated user with download access may open an
  application-owned, same-origin preview stream only for a PDF or raster image
  (`PNG`, `JPEG`, `GIF`, `WebP`, or `AVIF`). The server, rather than the
  filename or browser, enforces the media-type allowlist. Preview responses
  use `Content-Disposition: inline`, `Cache-Control: no-store`, and
  `X-Content-Type-Options: nosniff`; they never use a public URL. SVG, HTML,
  video, office documents, and every other media type are not previewable.
  PDF uses the browser's same-origin viewer in an unsandboxed iframe because
  Chrome's native PDF renderer is incompatible with the sandbox restriction;
  the server allowlist and response headers are the protection boundary.
- **Upload:** accept arbitrary file types. Upload one selected file to the
  current prefix, defaulting to its basename; the user may edit the filename.
  The server streams directly to S3 and must never buffer a whole object in
  memory or local disk. The maximum object size is **500 MiB**, enforced
  server-side. Do not expose object metadata, tags, ACLs, storage class, or
  encryption controls.
- **Overwrite:** reject accidental overwrite by default. A `readwrite` or
  `admin` user may explicitly confirm replacement of an existing object.
- **Delete:** `admin` only, individual objects only. Require the user to type
  or paste the exact object key before confirming deletion.
- **Folders:** S3 folders are prefixes. Creation writes an optional zero-byte
  key ending in `/`; no recursive folder deletion is provided.
- **ZIP download:** prefix downloads and selected-file ZIPs stream through the
  application and must not be assembled in memory, local disk, or a
  client-side blob. Selected-file ZIPs use an authenticated same-origin form
  POST so the browser receives the stream natively. Limit every archive,
  including a selected-file ZIP, to **2 GiB uncompressed** and **1,000
  objects**; make both limits deployment configuration.
- **Transfer limits:** permit up to **five concurrent uploads and five
  concurrent downloads per user; previews and selected-file ZIPs are download
  transfers. Enforce limits globally across replicas through PostgreSQL-backed
  active-transfer tracking with expiry/heartbeat handling.
- Send `Cache-Control: no-store` for authenticated pages, APIs, and streamed
  downloads. A user’s explicit download is intentionally written to their
  managed device.

## 5. AWS and Configuration Requirements

- Use AWS SDK for JavaScript v3 (`@aws-sdk/client-s3`) in the Node.js runtime.
- Resolve credentials only through the standard IRSA credential chain. Do not
  store `AWS_ACCESS_KEY_ID` or `AWS_SECRET_ACCESS_KEY` in source, environment
  configuration, or Vault.
- Bucket names are an explicit deployment allowlist of any size; the source
  code has no fixed bucket count and must not permit arbitrary bucket entry.
- The exact same reviewed inventory must drive both application configuration
  and least-privilege IAM policy. Grant only the S3 actions required above on
  the configured buckets and their objects—never broad S3 wildcard access.
- Use bucket-default encryption and disallow public ACLs.
- All environment-specific values are supplied by DevOps at deployment:
  Keycloak issuer/client and role mapping, approved HTTPS origin, bucket
  inventory, database/Vault settings, transfer/archive limits, bounded search
  limits (`S3_SEARCH_MAX_RESULTS` and `S3_SEARCH_MAX_PAGES`), and IRSA binding.
  The application contains no named-environment branches.
- Validate the full configuration at startup and fail fast when it is missing,
  malformed, or contradictory. Changes require reviewed, version-controlled
  configuration deployment and restart; no runtime configuration UI or hot
  reload exists.

## 6. Compliance Audit Trail

### Audit system of record

- PostgreSQL is the application audit system of record. Each deployment uses
  an isolated managed database or schema.
- Application runtime credentials have `INSERT` only on audit events;
  designated auditors/operators have separate read-only access; a distinct
  migration identity changes schema. Immutability is enforced by database
  privileges, not solely application code.
- Audit data is retained indefinitely. V1 implements no automatic cleanup,
  purge UI, or manual-purge workflow. Any exceptional retention review and
  deletion process is external to the application and must be documented
  there.
- The audit store is classified and protected at the same sensitivity as the
  underlying S3 data. Encrypt it at rest and in transit. Managed database
  backup and point-in-time recovery are deployment prerequisites owned by the
  platform/database team.

### Events and fail-closed behavior

- Record a durable, append-only attempt event before each S3 action and a
  separate outcome event afterward. Audit list, bucket search, download,
  preview, upload, overwrite, prefix creation, delete, prefix ZIP download,
  selected-file ZIP download, authorization denials, sign-in, sign-out, and
  callback failures.
- Every event includes timestamp, immutable Keycloak `sub`, snapshot of
  username/email, action, bucket, full key or prefix when applicable,
  correlation/request ID, source IP, user agent, and outcome/error class.
  A prefix-download outcome also records the resolved object count and size.
- Never record credentials, OAuth tokens, or object contents. Do not copy full
  object keys or user identifiers into ordinary operational logs.
- If the audit database cannot record the required pre-action event, deny the
  action. If the post-action outcome cannot be written, the durable attempt
  event remains an incomplete/unknown record for reconciliation; surface the
  audit failure and do not conceal it.

## 7. Security, Networking, and Runtime

- HTTPS is mandatory outside local development. HTTP-only ingress is not
  acceptable for a deployed compliance-grade service.
- The service is reachable only through the corporate network/VPN or an
  equivalent approved internal ingress policy, with Keycloak as a second
  control.
- Each deployment uses a dedicated HTTPS hostname. Permit only that exact
  origin as Keycloak redirect URI and trusted host; do not use wildcard
  redirects.
- Use CSRF/origin protection on every authenticated mutation in addition to
  OIDC `state` and PKCE. Delete and overwrite require the UI confirmations
  above; confirmations never replace server-side authorization.
- Use Next.js in its default Node.js runtime, packaged for containers with
  standalone output. Keep S3 and database access in server-side route
  handlers; stream object and ZIP responses.
- Provide a minimal unauthenticated health endpoint for infrastructure:
  liveness checks process health; readiness checks configuration and audit
  database connectivity. It must not access S3, disclose configuration, or
  generate audit events.
- Emit structured operational logs for troubleshooting, while excluding full
  object keys and sensitive user details. Alert routing is out of scope for
  v1.

## 8. Deployment Boundary and Ownership

- DevOps/platform owns deployment, production operation, access incidents,
  Keycloak role-mapping changes, audit-database health, and deployment
  approvals. Security/Compliance owns audit-policy decisions; S3 bucket
  owners review their bucket inventory.
- The application is built once and may be deployed many times. DevOps owns
  the independent configuration, identity client, IRSA role, bucket policy,
  database/schema, Vault path, hostname, and ingress configuration for each
  deployment.
- Infrastructure follows existing Helm, Terraform, ArgoCD, ECR, and platform
  node-group conventions. The application must not assume a particular
  deployment name or environment taxonomy.

## 9. External Deployment Prerequisites

Before a deployment is enabled, DevOps must provide and review:

1. An approved HTTPS internal hostname and ingress restriction.
2. A dedicated confidential Keycloak client, exact redirect URI, and role
   claim-to-permission mapping.
3. A reviewed, version-controlled bucket allowlist, used identically by the
   application and least-privilege IRSA policy.
4. A managed PostgreSQL audit store with runtime, migration, and auditor
   identities; encryption; backup; and point-in-time recovery.
5. Vault-managed OIDC/database secrets and an IRSA binding with no static AWS
   credentials.

## 10. Rejected Alternatives

| Option | Reason |
|---|---|
| Restore MinIO S3 gateway mode | Gateway mode was removed upstream and the obsolete implementation cannot support `ap-southeast-7`; maintaining a fork is unjustified. |
| Filestash OSS plus custom OIDC/proxy | Required OIDC and authorization capabilities are commercial-only; the workaround adds components and custom authorization work with licensing review overhead. |
| Filestash commercial license | Not the selected path; may be reconsidered only if the custom implementation estimate changes materially. |
