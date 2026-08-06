# Local Floci S3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide Floci-backed local S3 for the browser application and automated S3 integration tests while preserving IRSA-only deployed behavior.

**Architecture:** Compose runs persistent Floci on port 4566 and a one-shot AWS CLI initializer that creates every configured allowlisted bucket before the app starts. The configuration parser exposes a complete local-S3 tuple only in local mode; the S3 client consumes that tuple to enable endpoint override, path-style addressing, and emulator credentials, while all deployed configurations retain the default AWS credential chain.

**Tech Stack:** Docker Compose, `floci/floci:latest`, Amazon AWS CLI v2 container, AWS SDK for JavaScript v3, Zod, Vitest, Bun.

## Global Constraints

- This is local-development and local-integration-test infrastructure only; production uses AWS S3 through IRSA.
- `S3_ENDPOINT_URL`, `S3_ACCESS_KEY_ID`, and `S3_SECRET_ACCESS_KEY` are valid only when `APP_ENVIRONMENT=local`.
- All three local S3 settings must be supplied together; partial configuration fails fast.
- Existing `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `AWS_SESSION_TOKEN` remain forbidden in every environment.
- Deployed configurations must reject any local S3 endpoint or local S3 credential setting and must not override the AWS SDK endpoint or credentials.
- Floci creates exactly the buckets in `S3_ALLOWED_BUCKETS`; application code never creates buckets.
- Persist only Floci S3 data in the `floci_data` named volume at `/app/data`; do not alter application, Keycloak, or PostgreSQL volumes.
- Use exact emulator endpoint `http://floci:4566` inside Compose and `http://localhost:4566` from host-run integration tests.

---

### Task 1: Model and validate local S3 configuration

**Files:**
- Modify: `lib/config.ts`
- Modify: `lib/config.test.ts`

**Interfaces:**
- Produces: `AppConfig.localS3: { endpointUrl: string; accessKeyId: string; secretAccessKey: string } | null`.
- Consumes: `S3_ENDPOINT_URL`, `S3_ACCESS_KEY_ID`, and `S3_SECRET_ACCESS_KEY` from the deployment environment.

- [ ] **Step 1: Write failing configuration tests**

```ts
it("accepts complete local Floci configuration only in local mode", () => {
  expect(loadConfig({ ...validEnvironment,
    S3_ENDPOINT_URL: "http://floci:4566",
    S3_ACCESS_KEY_ID: "local-floci",
    S3_SECRET_ACCESS_KEY: "local-floci-secret"
  }).localS3).toEqual({
    endpointUrl: "http://floci:4566",
    accessKeyId: "local-floci",
    secretAccessKey: "local-floci-secret"
  });
});

it("rejects local S3 endpoint settings outside local development", () => {
  expect(() => loadConfig({ ...validEnvironment,
    APP_ENVIRONMENT: "deployment",
    NEXTAUTH_URL: "https://s3.internal.example",
    S3_ENDPOINT_URL: "http://floci:4566",
    S3_ACCESS_KEY_ID: "local-floci",
    S3_SECRET_ACCESS_KEY: "local-floci-secret"
  })).toThrow(/S3_ENDPOINT_URL.*local/i);
});
```

Add tests that reject each partial tuple: endpoint alone, endpoint plus access
key, and endpoint plus secret key. Add a test that a local configuration with
no local values returns `localS3: null`.

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `bunx vitest run lib/config.test.ts`

Expected: FAIL because `AppConfig` has no `localS3` field and local-only tuple
validation does not exist.

- [ ] **Step 3: Add the minimal configuration model and validation**

```ts
const localS3Values = [raw.S3_ENDPOINT_URL, raw.S3_ACCESS_KEY_ID, raw.S3_SECRET_ACCESS_KEY];
const hasAnyLocalS3Value = localS3Values.some(Boolean);
const hasCompleteLocalS3Config = localS3Values.every(Boolean);

if (raw.APP_ENVIRONMENT !== "local" && hasAnyLocalS3Value) {
  throw new Error("S3_ENDPOINT_URL and local S3 credentials are allowed only in local development");
}
if (raw.APP_ENVIRONMENT === "local" && hasAnyLocalS3Value && !hasCompleteLocalS3Config) {
  throw new Error("S3_ENDPOINT_URL, S3_ACCESS_KEY_ID, and S3_SECRET_ACCESS_KEY must be supplied together");
}
```

Validate `S3_ENDPOINT_URL` with `new URL`, return `null` when no local values
exist, otherwise return the three-string `localS3` object. Keep the existing
global AWS credential rejection unchanged.

- [ ] **Step 4: Run focused tests**

Run: `bunx vitest run lib/config.test.ts`

Expected: PASS, including all local tuple and deployment rejection cases.

- [ ] **Step 5: Commit the configuration task**

```bash
git add lib/config.ts lib/config.test.ts
git commit -m "feat: support local S3 emulator configuration"
```

### Task 2: Configure the SDK client for Floci only in local mode

**Files:**
- Modify: `lib/s3/client.ts`
- Create: `lib/s3/client.test.ts`

**Interfaces:**
- Consumes: `AppConfig.localS3` from Task 1.
- Produces: `s3ClientOptions(config: Pick<AppConfig, "s3Region" | "localS3">): S3ClientConfig` and `createS3Client(config): S3Client`.

- [ ] **Step 1: Write failing S3-client construction tests**

```ts
it("leaves endpoint and credentials undefined without local S3 configuration", () => {
  expect(s3ClientOptions({ s3Region: "ap-southeast-7", localS3: null })).toEqual({
    region: "ap-southeast-7"
  });
});

it("uses Floci endpoint, path addressing, and test credentials locally", () => {
  expect(s3ClientOptions({ s3Region: "ap-southeast-7", localS3: {
    endpointUrl: "http://floci:4566", accessKeyId: "local-floci", secretAccessKey: "local-floci-secret"
  } })).toEqual({
    region: "ap-southeast-7", endpoint: "http://floci:4566", forcePathStyle: true,
    credentials: { accessKeyId: "local-floci", secretAccessKey: "local-floci-secret" }
  });
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `bunx vitest run lib/s3/client.test.ts`

Expected: FAIL because `createS3Client` is not exported.

- [ ] **Step 3: Extract and use the minimal client factory**

```ts
export function s3ClientOptions(config: Pick<AppConfig, "s3Region" | "localS3">): S3ClientConfig {
  return {
    region: config.s3Region,
    ...(config.localS3 ? {
      endpoint: config.localS3.endpointUrl,
      forcePathStyle: true,
      credentials: { accessKeyId: config.localS3.accessKeyId, secretAccessKey: config.localS3.secretAccessKey }
    } : {})
  };
}

export function createS3Client(config: Pick<AppConfig, "s3Region" | "localS3">): S3Client {
  return new S3Client(s3ClientOptions(config));
}
```

Use the factory in `getS3Service`; leave service caching and all object
operations unchanged.

- [ ] **Step 4: Run the focused client and service tests**

Run: `bunx vitest run lib/s3/client.test.ts lib/s3/service.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the SDK task**

```bash
git add lib/s3/client.ts lib/s3/client.test.ts
git commit -m "feat: route local S3 client to Floci"
```

### Task 3: Run and initialize persistent Floci in Compose

**Files:**
- Modify: `compose.yaml`
- Modify: `.env.example`
- Modify: `README.md`

**Interfaces:**
- Consumes: `S3_ALLOWED_BUCKETS`, `S3_REGION`, and local S3 tuple values.
- Produces: reachable `floci` and successful one-shot `floci-init` services before `app` starts.

- [ ] **Step 1: Define failing Compose checks**

Run:

```bash
docker compose config --quiet
docker compose up -d floci floci-init
docker compose wait floci-init
aws --endpoint-url http://localhost:4566 s3api list-buckets
```

Expected before implementation: Floci services are undefined and the endpoint
is unavailable.

- [ ] **Step 2: Add the Floci service**

```yaml
floci:
  image: floci/floci:latest
  environment:
    FLOCI_STORAGE_MODE: persistent
    FLOCI_STORAGE_PERSISTENT_PATH: /app/data
  ports:
    - "4566:4566"
  volumes:
    - floci_data:/app/data
```

The initializer in the next step is the readiness gate: it polls the actual S3
`ListBuckets` API before provisioning, so it verifies the service this app
will use rather than an implementation-specific health route.

- [ ] **Step 3: Add the idempotent bucket initializer and app dependency**

```yaml
floci-init:
  image: amazon/aws-cli:2
  entrypoint: ["/bin/sh", "-ec"]
  command: >-
    until aws --endpoint-url "$S3_ENDPOINT_URL" s3api list-buckets >/dev/null 2>&1; do sleep 1; done;
    for bucket in $(echo "$S3_ALLOWED_BUCKETS" | tr ',' ' '); do
      aws --endpoint-url "$S3_ENDPOINT_URL" s3api head-bucket --bucket "$bucket" 2>/dev/null ||
      aws --endpoint-url "$S3_ENDPOINT_URL" s3api create-bucket --bucket "$bucket" --create-bucket-configuration "LocationConstraint=$AWS_DEFAULT_REGION";
    done
  environment:
    AWS_DEFAULT_REGION: ${S3_REGION}
    AWS_ACCESS_KEY_ID: ${S3_ACCESS_KEY_ID}
    AWS_SECRET_ACCESS_KEY: ${S3_SECRET_ACCESS_KEY}
    S3_ENDPOINT_URL: http://floci:4566
    S3_ALLOWED_BUCKETS: ${S3_ALLOWED_BUCKETS}
  depends_on:
    floci:
      condition: service_started
```

Set app-container values to `S3_ENDPOINT_URL=http://floci:4566`,
`S3_ACCESS_KEY_ID=local-floci`, and `S3_SECRET_ACCESS_KEY=local-floci-secret`.
Make `app` depend on `floci-init: condition: service_completed_successfully`.
Add `floci_data` to Compose volumes. Add the corresponding sample local values
to `.env.example` for host-run integration tests.

- [ ] **Step 4: Document operations and local state reset**

Document the published Floci URL, automatic bucket initialization, persistent
object state, and the safe S3-only reset command:

```bash
docker compose down
docker volume rm s3-gateway-keycloak_floci_data
docker compose up --build
```

State that `docker compose down -v` also deletes the application and Keycloak
databases and is not a S3-only reset.

- [ ] **Step 5: Run Compose bucket checks**

Run:

```bash
docker compose config --quiet
docker compose up -d --build
docker compose wait floci-init
aws --endpoint-url http://localhost:4566 s3api list-buckets --query "Buckets[].Name" --output text
curl --fail --silent http://localhost:3000/api/health
```

Expected: each configured bucket appears exactly once and app health returns
`{"status":"ok"}`.

- [ ] **Step 6: Commit Compose and documentation**

```bash
git add compose.yaml .env.example README.md
git commit -m "feat: add persistent local Floci S3"
```

### Task 4: Add Floci-backed S3 integration coverage

**Files:**
- Create: `lib/s3/floci.integration.test.ts`
- Modify: `package.json`
- Modify: `README.md`

**Interfaces:**
- Consumes: Floci on `http://localhost:4566`, environment-local emulator credentials, and one bucket from `S3_ALLOWED_BUCKETS`.
- Produces: `bun run test:s3-integration`, a separate Docker-required integration command.

- [ ] **Step 1: Write the first real-S3 integration test**

```ts
// @vitest-environment node
it("writes, conditionally overwrites, lists, downloads, and deletes a Floci object", async () => {
  const key = `integration/${crypto.randomUUID()}.txt`;
  await service.putObject(bucket, key, Readable.from("first"), "text/plain", 5);
  await expect(service.putObject(bucket, key, Readable.from("second"), "text/plain", 6)).rejects.toThrow();
  await service.putObject(bucket, key, Readable.from("second"), "text/plain", 6, true);
  expect((await service.listObjects(bucket, "integration/", undefined)).objects.map((entry) => entry.key)).toContain(key);
  expect(await readStream((await service.getObject(bucket, key)).body)).toBe("second");
  await service.deleteObject(bucket, key);
});
```

Use an `afterEach` cleanup helper that deletes only keys generated by that test.

- [ ] **Step 2: Run it to verify the initial environment failure**

Run: `bunx vitest run lib/s3/floci.integration.test.ts`

Expected before Compose integration is started: FAIL with a connection error to
`localhost:4566`, proving the test targets Floci rather than mocked S3.

- [ ] **Step 3: Add the real Floci service factory and archive test**

Construct the integration `S3Client` with endpoint `http://localhost:4566`,
`forcePathStyle: true`, region `ap-southeast-7`, and the local S3 credentials.
Create `createS3Service` with one configured bucket. Add a second test that
creates two unique prefix objects, reads the returned ZIP stream, and asserts
the archive reports object count two and expected uncompressed total size.

- [ ] **Step 4: Add a dedicated command and test documentation**

Add:

```json
"test:s3-integration": "vitest run lib/s3/floci.integration.test.ts"
```

Document that `docker compose up -d` is a prerequisite and that this command
uses Floci, never AWS.

- [ ] **Step 5: Run real integration and full verification**

Run:

```bash
bun run test:s3-integration
bun run test
bun run lint
bun run typecheck
bun run build
```

Expected: all commands pass; database integration tests require the already
running Compose PostgreSQL service.

- [ ] **Step 6: Commit integration coverage**

```bash
git add lib/s3/floci.integration.test.ts package.json README.md
git commit -m "test: cover S3 operations against Floci"
```
