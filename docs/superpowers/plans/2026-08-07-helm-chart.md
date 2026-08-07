# Helm Chart Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a production S3 Browser image and a Helm chart that installs the application with a persistent, single-replica PostgreSQL database and uses a DevOps-supplied secret.

**Architecture:** The Dockerfile keeps its Compose-compatible `development` target and adds a default `production` target that contains the Next.js standalone server plus Drizzle migration tooling. The `charts/s3-browser` Helm chart renders an application deployment with a migration init container, a cluster-internal PostgreSQL StatefulSet with retained PVCs, and only non-secret configuration. One existing secret is referenced by both workloads; Keycloak, ingress/TLS, IRSA policy, S3, storage provisioning, and secret creation remain external.

> **Approved implementation correction:** Helm runs `pre-install` hooks before
> normal resources, so a hook migration Job would run before the PostgreSQL
> StatefulSet exists on a first install. The migration Job portions of this
> plan are superseded by a `bun run db:migrate` init container in the
> application Deployment. Kubernetes retries that init container until the
> normal PostgreSQL workload is ready; `helm upgrade --install --wait --timeout
> 10m` is the release gate.

**Tech Stack:** Bun 1.3, Next.js 16 standalone output, Drizzle Kit, PostgreSQL 17, Helm 4 templates, Vitest, Kubernetes 1.27+.

## Global Constraints

- The chart targets one separately deployed environment and must not select or infer environments in application source.
- The release requires a pre-created secret; Helm must not create or embed credential values in rendered manifests.
- The existing secret must contain `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `DATABASE_URL`, `NEXTAUTH_SECRET`, and `KEYCLOAK_CLIENT_SECRET`.
- `DATABASE_URL` is supplied verbatim so reserved PostgreSQL password characters can be URL encoded safely.
- `APP_ENVIRONMENT` is always `deployment`; the chart must not set local S3 endpoint or static AWS credential variables.
- PostgreSQL data must remain after normal upgrades, scale-down, and Helm uninstall; deletion is reviewed and manual.
- The runtime default image is `reefwn/s3-gateway-keycloak:v1.0.1`; `v1.0.0` remains the tag for source commit `3eeae2c`.
- Keycloak, HTTPS ingress/certificates, S3 buckets/policies, IRSA IAM role, storage class/PV provisioning, monitoring, backup/recovery, and secret creation are out of chart scope.

---

### Task 1: Add a production-capable image target

**Files:**
- Modify: `Dockerfile`
- Modify: `.dockerignore`
- Create: `scripts/verify-production-image.sh`
- Test: `scripts/verify-production-image.sh`

**Interfaces:**
- Consumes: `package.json` scripts `build`, `start`, and `db:migrate`; `next.config.ts` standalone output; `db/migrations`.
- Produces: the default Docker build target that starts `server.js` on port 3000; `development` remains available to `compose.yaml`.

- [ ] **Step 1: Write the failing production-image verification script**

Create `scripts/verify-production-image.sh`:

```sh
#!/usr/bin/env sh
set -eu

image_name="s3-browser-production-verify:local"
docker build --target production --tag "$image_name" .
docker image inspect "$image_name" --format '{{.Config.User}} {{json .Config.Cmd}} {{json .Config.ExposedPorts}}' \
  | grep -F 'app' \
  | grep -F 'server.js' \
  | grep -F '3000/tcp'
docker run --rm --entrypoint sh "$image_name" -c 'test -f /app/server.js && test -f /app/db/migrations/meta/_journal.json && test -x /usr/local/bin/bun'
```

- [ ] **Step 2: Run the script to verify it fails because the production target is absent**

Run: `sh scripts/verify-production-image.sh`

Expected: Docker reports that target stage `production` does not exist.

- [ ] **Step 3: Replace the Dockerfile with development and production targets**

Keep the initial `development` target and add:

```dockerfile
FROM oven/bun:1.3.14-debian AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM oven/bun:1.3.14-debian AS production
WORKDIR /app
ENV NODE_ENV=production
RUN groupadd --system app && useradd --system --gid app --create-home app
COPY --from=build --chown=app:app /app/.next/standalone ./
COPY --from=build --chown=app:app /app/.next/static ./.next/static
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/package.json /app/drizzle.config.ts ./
COPY --from=build --chown=app:app /app/db ./db
USER app
EXPOSE 3000
CMD ["bun", "server.js"]
```

Ensure the `development` target still installs dependencies, creates the same non-root `app` user, exposes 3000, and runs `bun dev`. Keep Docker build context free of `.env`, `node_modules`, `.next`, coverage, and add `charts/*/values-production.example.yaml` only if it ever contains rendered/example secrets (the initial example must not).

- [ ] **Step 4: Run the production-image verification script**

Run: `sh scripts/verify-production-image.sh`

Expected: the image builds, reports user `app`, runs `server.js`, exposes port 3000, and contains Drizzle migrations.

- [ ] **Step 5: Commit the production image target**

```bash
git add Dockerfile .dockerignore scripts/verify-production-image.sh
git commit -m "feat: add production container image"
```

### Task 2: Create a render-tested Helm chart skeleton and values contract

**Files:**
- Create: `charts/s3-browser/Chart.yaml`
- Create: `charts/s3-browser/values.yaml`
- Create: `charts/s3-browser/values.schema.json`
- Create: `charts/s3-browser/.helmignore`
- Create: `charts/s3-browser/tests/render.test.ts`
- Create: `charts/s3-browser/values-production.example.yaml`

**Interfaces:**
- Consumes: the `production` image from Task 1 and a secret whose six exact keys are defined in the global constraints.
- Produces: a Helm chart named `s3-browser`, version `0.1.0`, with a validated non-secret values surface that later templates consume.

- [ ] **Step 1: Write the failing Helm render test**

Create `charts/s3-browser/tests/render.test.ts` with a Node Vitest environment. Use `spawnSync` to call Helm with a release name and a fixture values file; fail with stderr if Helm exits non-zero. Assert that the render has the application Deployment, PostgreSQL StatefulSet, hook Job, no `kind: Secret`, no `AWS_ACCESS_KEY_ID`, and exactly the required secret key references:

```ts
// @vitest-environment node
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function render(extraArgs: string[] = []) {
  return spawnSync("helm", ["template", "s3-browser", ".", "-f", "values-production.example.yaml", ...extraArgs], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8"
  });
}

describe("s3-browser chart", () => {
  it("renders the application, migration gate, and retained PostgreSQL storage", () => {
    const result = render();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("kind: Deployment");
    expect(result.stdout).toContain("kind: StatefulSet");
    expect(result.stdout).toContain("kind: Job");
    expect(result.stdout).toContain("helm.sh/hook: pre-install,pre-upgrade");
    expect(result.stdout).toContain("whenDeleted: Retain");
    expect(result.stdout).not.toContain("kind: Secret");
    expect(result.stdout).not.toContain("AWS_ACCESS_KEY_ID");
    expect(result.stdout).toContain("name: deployment-secrets");
  });

  it("rejects an empty existing secret name", () => {
    const result = render(["--set", "existingSecret.name="]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/existingSecret\.name/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails because the chart is absent**

Run: `bunx vitest run charts/s3-browser/tests/render.test.ts`

Expected: FAIL because Helm cannot find `charts/s3-browser`.

- [ ] **Step 3: Add chart metadata, defaults, schema, and a credential-free production example**

Create a v2 chart with `kubeVersion: ">=1.27.0-0"`. Put the following deployment-facing defaults in `values.yaml`:

```yaml
image:
  repository: reefwn/s3-gateway-keycloak
  tag: v1.0.1
  pullPolicy: IfNotPresent

existingSecret:
  name: ""

app:
  replicaCount: 1
  nextAuthUrl: https://s3-browser.internal.example
  keycloakIssuer: https://keycloak.internal.example/realms/internal
  keycloakClientId: s3-browser
  s3Region: ap-southeast-7
  allowedBuckets: reports,uploads
  roleClaim: resource_access.s3-browser.roles
  roleMapping: '{"s3-browser-admin":"admin","s3-browser-readwrite":"readwrite","s3-browser-readonly":"readonly"}'
  objectMaxBytes: 524288000
  transferLimit: 5
  archiveMaxObjects: 1000
  archiveMaxBytes: 2147483648
```

Add structured settings for the app service, pod resources/security context, service account annotations/existing name, PostgreSQL image/service/resources/persistence, migration job resources, optional ingress, pod labels/annotations, and image pull secrets. The production example must set only safe representative URLs, `existingSecret.name: deployment-secrets`, a bucket allowlist, an optional storage class, and an IRSA annotation placeholder such as `eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/s3-browser`; it must contain no passwords, tokens, or a `DATABASE_URL`.

Make `values.schema.json` reject an empty `existingSecret.name`, require HTTPS URLs for `app.nextAuthUrl` and `app.keycloakIssuer`, require at least one comma-separated bucket character, enforce positive integer object/transfer/archive limits, and restrict `service.type` to `ClusterIP` or `LoadBalancer`.

- [ ] **Step 4: Run the test to verify it now fails only because workload templates are absent**

Run: `bunx vitest run charts/s3-browser/tests/render.test.ts`

Expected: the first assertion fails because no Deployment, StatefulSet, or Job is rendered; the empty secret assertion fails schema validation as expected.

- [ ] **Step 5: Commit the chart contract**

```bash
git add charts/s3-browser
git commit -m "feat: scaffold s3 browser helm chart"
```

### Task 3: Render the persistent PostgreSQL database and migration gate

**Files:**
- Create: `charts/s3-browser/templates/_helpers.tpl`
- Create: `charts/s3-browser/templates/postgresql-service.yaml`
- Create: `charts/s3-browser/templates/postgresql-statefulset.yaml`
- Create: `charts/s3-browser/templates/migration-job.yaml`
- Modify: `charts/s3-browser/tests/render.test.ts`

**Interfaces:**
- Consumes: `existingSecret.name`, PostgreSQL image/persistence/resource values, and the production image migration command from Task 1.
- Produces: a release-scoped PostgreSQL endpoint `<release>-s3-browser-postgresql`, a retained single replica database volume, and a Helm migration hook that exits successfully before application rollout.

- [ ] **Step 1: Extend the failing render test for database safety**

Add assertions that the rendered PostgreSQL StatefulSet has one replica, `volumeClaimTemplates`, `persistentVolumeClaimRetentionPolicy` with `whenDeleted: Retain` and `whenScaled: Retain`, a `postgresql` headless Service, secret refs for `POSTGRES_DB`, `POSTGRES_USER`, and `POSTGRES_PASSWORD`, and no service `type: LoadBalancer`. Assert the Job command is exactly `bun run db:migrate`, has both hook annotations, and reads `DATABASE_URL`, `NEXTAUTH_SECRET`, and `KEYCLOAK_CLIENT_SECRET` from `deployment-secrets`.

- [ ] **Step 2: Run the test to verify the new database assertions fail**

Run: `bunx vitest run charts/s3-browser/tests/render.test.ts`

Expected: FAIL on the first missing PostgreSQL or migration assertion.

- [ ] **Step 3: Implement PostgreSQL and migration templates**

Use `_helpers.tpl` to define chart name, full name, common labels, selector labels, app service account name, and PostgreSQL service name. Render:

- A headless `ClusterIP` PostgreSQL Service with `clusterIP: None`, a selector matching the StatefulSet, and port 5432 only.
- A PostgreSQL StatefulSet with `replicas: 1`, `serviceName` set to that service, `persistentVolumeClaimRetentionPolicy` retaining both deletion and scale-down claims, a `volumeClaimTemplates` claim mounted at `/var/lib/postgresql/data`, and values-driven access mode, size, and optional storage class.
- PostgreSQL environment variables sourced with `secretKeyRef` from `existingSecret.name`, never from Helm values.
- TCP readiness and liveness probes on port 5432; non-privileged container security context; resources from values; and no public exposure.
- A batch Job annotated `helm.sh/hook: pre-install,pre-upgrade`, `helm.sh/hook-weight: "-5"`, and `helm.sh/hook-delete-policy: before-hook-creation,hook-succeeded`. Use the application image, `command: ["bun", "run", "db:migrate"]`, a bounded `backoffLimit`, `restartPolicy: OnFailure`, application config/secret environment variables, and the same non-root security constraints as the application. Leave a failed Job for diagnostics.

Do not add a database `Secret`, static AWS values, or a sleep/wait loop. Kubernetes Job retries and Helm hook failure are the migration gate.

- [ ] **Step 4: Run the chart test and Helm lint**

Run: `bunx vitest run charts/s3-browser/tests/render.test.ts && helm lint charts/s3-browser -f charts/s3-browser/values-production.example.yaml`

Expected: PASS. The render contains the retained database and hook migration gate; lint reports zero errors.

- [ ] **Step 5: Commit database lifecycle templates**

```bash
git add charts/s3-browser
git commit -m "feat: add persistent postgres helm workload"
```

### Task 4: Render the hardened application workload and optional ingress

**Files:**
- Create: `charts/s3-browser/templates/serviceaccount.yaml`
- Create: `charts/s3-browser/templates/configmap.yaml`
- Create: `charts/s3-browser/templates/deployment.yaml`
- Create: `charts/s3-browser/templates/service.yaml`
- Create: `charts/s3-browser/templates/ingress.yaml`
- Modify: `charts/s3-browser/tests/render.test.ts`

**Interfaces:**
- Consumes: the ConfigMap/non-secret values contract from Task 2, secret name from Task 2, and database endpoint/helpers from Task 3.
- Produces: an IRSA-annotatable service account, deployment-ready configuration, a cluster-local application service, and an explicitly opt-in ingress.

- [ ] **Step 1: Extend the failing render test for app security and configuration**

Assert that the Deployment uses `reefwn/s3-gateway-keycloak:v1.0.1`, has `APP_ENVIRONMENT` set to `deployment`, references `NEXTAUTH_SECRET`, `KEYCLOAK_CLIENT_SECRET`, and `DATABASE_URL` only through `deployment-secrets`, has `/api/health` readiness/liveness probes, uses a `readOnlyRootFilesystem`, `allowPrivilegeEscalation: false`, and drops all Linux capabilities. Assert the ConfigMap contains `S3_ALLOWED_BUCKETS` and `S3_ROLE_MAPPING` but not `DATABASE_URL` or AWS credential keys. Assert no Ingress renders with defaults, then render with `--set ingress.enabled=true` and assert an Ingress with the configured TLS secret and host.

- [ ] **Step 2: Run the test to verify the new app assertions fail**

Run: `bunx vitest run charts/s3-browser/tests/render.test.ts`

Expected: FAIL because application workload templates do not exist yet.

- [ ] **Step 3: Implement application templates**

Render a ServiceAccount unless `serviceAccount.create` is false, applying user-supplied annotations unchanged for IRSA. Render a ConfigMap with only the global non-secret configuration and `APP_ENVIRONMENT: deployment`.

Render an application Deployment with one default replica, values-driven rolling update strategy/resources/image pull settings, environment values from the ConfigMap, and the three application secret keys from `existingSecret.name`. The Deployment must use the selected service account, expose named port `http` on 3000, and include `/api/health` readiness, liveness, and startup probes. Apply pod/container security contexts that run as non-root, disallow privilege escalation, drop all capabilities, and mount an `emptyDir` at `/tmp` while retaining a read-only root filesystem.

Render a ClusterIP Service on port 80 targeting `http`/3000. Render no ingress unless `ingress.enabled` is true; when true, render only the configured class, host, path, TLS secret, and annotations. Do not include a default host or TLS secret that could accidentally expose the service.

- [ ] **Step 4: Run the chart test and rendered-manifest validation**

Run: `bunx vitest run charts/s3-browser/tests/render.test.ts && helm lint charts/s3-browser -f charts/s3-browser/values-production.example.yaml && helm template s3-browser charts/s3-browser -f charts/s3-browser/values-production.example.yaml > /tmp/s3-browser-manifests.yaml`

Expected: PASS. The rendered manifests contain no `kind: Secret`, no AWS static credential variables, and no default Ingress.

- [ ] **Step 5: Commit application workload templates**

```bash
git add charts/s3-browser
git commit -m "feat: add s3 browser helm deployment"
```

### Task 5: Document deployment, release the corrected image, and run repository verification

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-08-07-helm-chart-design.md`
- Modify: `docs/superpowers/plans/2026-08-07-helm-chart.md`
- Test: `charts/s3-browser/tests/render.test.ts`

**Interfaces:**
- Consumes: the rendered chart and image behavior from Tasks 1–4.
- Produces: operator instructions for constructing a valid existing secret, installing/upgrading the release, inspecting failed migrations, and retaining/deleting PostgreSQL data deliberately.

- [ ] **Step 1: Extend the render test to prove the documented command works**

Add a test that invokes:

```ts
spawnSync("helm", [
  "template", "s3-browser", ".",
  "-f", "values-production.example.yaml",
  "--set", "existingSecret.name=deployment-secrets"
], { cwd: new URL("..", import.meta.url), encoding: "utf8" });
```

Assert its status is zero and it references the exact existing secret name. This catches a documentation/example drift.

- [ ] **Step 2: Run the test to verify it fails before the final documentation/default alignment**

Run: `bunx vitest run charts/s3-browser/tests/render.test.ts`

Expected: FAIL only if the example/default contract has drifted; correct the fixture or default so the test captures the documented install path.

- [ ] **Step 3: Update the README with chart deployment instructions**

Add a `## Kubernetes deployment` section that:

1. States the `v1.0.1` production image must be built and pushed after this change.
2. Shows a `kubectl create secret generic deployment-secrets` example with all six required keys, using shell prompts or file references instead of literal secrets.
3. Explains that `DATABASE_URL` must target the release PostgreSQL service and URL-encode reserved password characters.
4. Shows `helm upgrade --install s3-browser ./charts/s3-browser --namespace s3-browser --create-namespace -f values-production.yaml`.
5. States that Keycloak, HTTPS ingress/TLS, IRSA policy, S3, PV provisioning, backups, and Secret ownership are external prerequisites.
6. Shows how to inspect a failed migration hook Job and states PVCs are retained after uninstall for manual review/deletion.

Update the image build/push instructions to build the default production target and tag/push `reefwn/s3-gateway-keycloak:v1.0.1`. Keep local Compose instructions explicitly on the `development` target.

- [ ] **Step 4: Run focused and repository verification**

Run:

```bash
bunx vitest run charts/s3-browser/tests/render.test.ts
helm lint charts/s3-browser -f charts/s3-browser/values-production.example.yaml
bun run lint
bun run typecheck
bun run build
bun run test
```

Expected: chart checks, lint, typecheck, build, and unit tests pass. If database integration tests cannot reach the local PostgreSQL port because of sandbox policy, report that specific environmental block separately while retaining all passing test results.

- [ ] **Step 5: Build and publish the deployable image outside the sandbox**

Run from a Docker-capable terminal:

```bash
docker build -t reefwn/s3-gateway-keycloak:v1.0.1 .
docker push reefwn/s3-gateway-keycloak:v1.0.1
```

Then record its immutable digest in the deployment values before production rollout.

- [ ] **Step 6: Commit documentation and chart verification**

```bash
git add README.md docs/superpowers/specs/2026-08-07-helm-chart-design.md docs/superpowers/plans/2026-08-07-helm-chart.md charts/s3-browser
git commit -m "docs: document helm deployment"
```
