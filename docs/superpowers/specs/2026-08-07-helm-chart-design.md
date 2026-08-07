# Helm Chart Design

## Purpose

Package a deployable S3 Browser release that runs the Next.js application and
one PostgreSQL database per Kubernetes deployment. The chart is intended for a
single configured environment; it does not model, select, or promote between
environments.

## Deployment Boundary

The chart will install only these workload-owned components:

- The S3 Browser application `Deployment` and cluster-local `Service`.
- A single-replica PostgreSQL `StatefulSet`, cluster-local headless `Service`,
  and dynamically provisioned PVC.
- An application migration init container that gates each new application pod.

Keycloak, HTTPS ingress, certificates, IRSA/service-account annotations,
S3 buckets and policies, storage classes/PVs, monitoring, backups, and secret
creation remain deployment-managed prerequisites. The chart does not include
local Floci or any static AWS credentials.

## Production Image

The existing Dockerfile is a development target: it starts `bun dev` and does
not contain an application production build. The chart therefore requires a
multi-stage production target that installs dependencies with Bun, builds the
Next.js standalone output, runs as a non-root user, and starts the standalone
server. It must also include Drizzle migration files and the migration command
needed by the application migration init container.

The chart's default image reference will be `reefwn/s3-gateway-keycloak` at
`v1.0.1`. The already published `v1.0.0` image should be associated with the
exact source commit that produced it, but it is not the chart's deployment
default because it was built from the development-only Dockerfile.

## Chart Layout

The repository will contain one chart at `charts/s3-browser`:

- `Chart.yaml`, `values.yaml`, `values.schema.json`, and `.helmignore` define
  chart metadata, safe defaults, and install-time validation.
- Helper templates create consistent release-scoped names and labels.
- Application templates render the service account, ConfigMap, Deployment,
  Service, and migration init container.
- PostgreSQL templates render the headless Service and StatefulSet with its
  PVC claim template.
- A commented `values-production.example.yaml` documents the required
  deployment values without containing credentials.

The chart will require Kubernetes 1.27 or later so the PostgreSQL StatefulSet
can use `persistentVolumeClaimRetentionPolicy`. Both `whenDeleted` and
`whenScaled` retain PVCs. A Helm uninstall therefore leaves database data in
place for reviewed, manual disposal.

## Configuration and Secrets

The release requires a pre-created Kubernetes secret. Helm will never render
or store a credential in a release manifest. The secret's name is supplied in
`existingSecret.name` and must contain these exact keys:

- `POSTGRES_DB`, `POSTGRES_USER`, and `POSTGRES_PASSWORD` for PostgreSQL.
- `DATABASE_URL` for the application and migration init container. It must encode any
  reserved password characters correctly and point at the release's
  PostgreSQL service.
- `NEXTAUTH_SECRET` and `KEYCLOAK_CLIENT_SECRET` for the application.

The application ConfigMap contains only non-secret deployment configuration:
`APP_ENVIRONMENT=deployment`, public application/Keycloak URLs, Keycloak
client ID, S3 region and bucket allowlist, claim and role mapping, and the
object/transfer/archive limits. It deliberately omits endpoint overrides and
all AWS credential variables, allowing the AWS SDK default IRSA chain to be
the only production credential source.

The default `ServiceAccount` is created without annotations; chart values can
provide its annotations so DevOps can attach the environment's IRSA role. A
pre-existing service account can also be selected.

## Workload Flow

1. PostgreSQL starts with data mounted at `/var/lib/postgresql/data` from a
   release-scoped PVC. The pod has a TCP readiness probe and no public service.
2. Each new S3 Browser pod first runs `bun run db:migrate` as an init
   container. Kubernetes retries it until PostgreSQL is reachable and the
   migration succeeds; the application container cannot start first.
3. `helm upgrade --install --wait --timeout 10m` returns failure if the new
   application pod does not become ready, including when its migration init
   container cannot succeed.
4. The application runs as a non-root user with read-only root filesystem,
   dropped Linux capabilities, no privilege escalation, and health probes on
   `/api/health`. It exposes only port 3000 through a cluster-local service.

## Values and Operational Defaults

The default chart values are intentionally conservative:

- Application: one replica, resource requests/limits, rolling updates,
  autoscaling disabled, and a ClusterIP service.
- PostgreSQL: one replica, 10 GiB ReadWriteOnce PVC, a configurable storage
  class, resource requests/limits, and no public service.
- S3 Browser limits: 500 MiB uploads, five concurrent uploads and downloads
  per actor, 1,000 archive objects, and a 2 GiB uncompressed archive limit.
- No ingress object: the platform's existing ingress/certificate practice
  remains authoritative. An optional ingress can be enabled only when
  deployment owners explicitly provide its class, host, TLS secret, and
  annotations.

## Validation and Verification

Automated chart tests will render a valid production values fixture and assert
that it produces the expected deployment, database StatefulSet, retained PVC
policy, migration init container, secret references, non-secret ConfigMap, and no static
AWS credentials. A negative fixture will prove rendering fails without the
required existing secret and deployment configuration.

Repository verification will include `helm lint`, `helm template` with the
valid fixture, the chart test suite, `bun run lint`, `bun run typecheck`, and
`bun run build`. A cluster smoke test remains a deployment-team activity: it
uses a supplied secret and storage class, waits for migrations and readiness,
then verifies Keycloak login and an IRSA-backed S3 browse operation.

## Scope

This work does not create Keycloak, an ingress controller, TLS certificates,
an AWS IAM role, an S3 bucket, a Kubernetes Secret, PostgreSQL backups, HA
PostgreSQL, automatic database deletion, or environment-aware application
source code. It adds a production image path and a single-environment Helm
release chart with an application-owned persistent PostgreSQL instance.
