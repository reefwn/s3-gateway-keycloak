# Local Keycloak Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run a reproducible local Keycloak realm that signs the S3 Browser in as deterministic `readonly`, `readwrite`, and `admin` test users.

**Architecture:** Docker Compose adds an independent Keycloak PostgreSQL database and a Keycloak 26 service. The realm is imported from a read-only JSON fixture and its browser-facing issuer is `http://keycloak.localhost:8080/realms/internal`; the Compose network aliases the Keycloak container as `keycloak.localhost` so that the Next.js server and host browser use the same issuer string. The imported confidential client emits client roles in the UserInfo response where NextAuth reads them.

**Tech Stack:** Docker Compose, PostgreSQL 17, Keycloak 26, Keycloak OIDC realm import, NextAuth Keycloak provider, Bun.

## Global Constraints

- Local-only integration; deployment-time Keycloak configuration remains DevOps-owned.
- Use `http://keycloak.localhost:8080/realms/internal` only when `APP_ENVIRONMENT=local`.
- The exact application OIDC redirect URI is `http://localhost:3000/api/auth/callback/keycloak`.
- Seed only three non-production users: `s3-readonly`, `s3-readwrite`, and `s3-admin`.
- Each seeded user has exactly one mapped application client role.
- Test credentials are local fixtures and must be clearly documented as unsafe for any non-local environment.
- Do not add AWS credentials, buckets, S3 data, or deployment infrastructure.
- Keep the existing app PostgreSQL database separate from Keycloak’s database.

---

### Task 1: Add the deterministic Keycloak realm fixture

**Files:**
- Create: `infra/keycloak/internal-realm.json`
- Test: `infra/keycloak/internal-realm.test.ts`

**Interfaces:**
- Consumes: `S3_ROLE_CLAIM=resource_access.s3-browser.roles` and the three role names from `.env.example`.
- Produces: an importable `internal` realm with the `s3-browser` confidential OIDC client.

- [ ] **Step 1: Write the failing fixture validation test**

```ts
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("local Keycloak realm", () => {
  it("creates the app client and one user for each application role", async () => {
    const realm = JSON.parse(await readFile("infra/keycloak/internal-realm.json", "utf8"));
    const client = realm.clients.find((entry: { clientId: string }) => entry.clientId === "s3-browser");

    expect(realm.realm).toBe("internal");
    expect(client.redirectUris).toEqual(["http://localhost:3000/api/auth/callback/keycloak"]);
    expect(client.clientAuthenticatorType).toBe("client-secret");
    expect(Object.keys(client.roles.client)).toEqual(expect.arrayContaining([
      "s3-browser-admin", "s3-browser-readwrite", "s3-browser-readonly"
    ]));
    expect(realm.users.map((user: { username: string }) => user.username)).toEqual([
      "s3-readonly", "s3-readwrite", "s3-admin"
    ]);
  });
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `bunx vitest run infra/keycloak/internal-realm.test.ts`

Expected: FAIL because the realm fixture does not exist.

- [ ] **Step 3: Add the minimal importable realm**

```json
{
  "realm": "internal",
  "enabled": true,
  "clients": [{
    "clientId": "s3-browser",
    "clientAuthenticatorType": "client-secret",
    "secret": "local-keycloak-client-secret",
    "publicClient": false,
    "standardFlowEnabled": true,
    "redirectUris": ["http://localhost:3000/api/auth/callback/keycloak"],
    "webOrigins": ["http://localhost:3000"],
    "roles": { "client": {
      "s3-browser-admin": {},
      "s3-browser-readwrite": {},
      "s3-browser-readonly": {}
    } }
  }],
  "users": []
}
```

Add the three enabled users with `temporary: false` password credentials and a
single `clientRoles["s3-browser"]` value. Add an OIDC client-role mapper that
includes `resource_access.s3-browser.roles` in the `userinfo`, ID-token, and
access-token claims.

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `bunx vitest run infra/keycloak/internal-realm.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the fixture task**

```bash
git add infra/keycloak/internal-realm.json infra/keycloak/internal-realm.test.ts
git commit -m "feat: add local Keycloak realm fixture"
```

### Task 2: Add local Keycloak services to Compose

**Files:**
- Modify: `compose.yaml`
- Test: `compose.yaml` service health and OIDC discovery endpoint

**Interfaces:**
- Consumes: `infra/keycloak/internal-realm.json` as `/opt/keycloak/data/import/internal-realm.json`.
- Produces: a healthy Keycloak service accessible at `http://keycloak.localhost:8080` from both the app container and host browser.

- [ ] **Step 1: Define the expected Compose service checks before editing**

Run:

```bash
docker compose config --quiet
docker compose up -d keycloak keycloak-postgres
docker compose ps keycloak keycloak-postgres
curl --fail http://keycloak.localhost:8080/realms/internal/.well-known/openid-configuration
```

Expected before implementation: `docker compose config --quiet` succeeds, but
the Keycloak service and discovery endpoint are unavailable.

- [ ] **Step 2: Add the Keycloak PostgreSQL service**

Add a `keycloak-postgres` service using `postgres:17-alpine` with database,
user, and password all scoped to the local Keycloak fixture. Add a
`pg_isready` health check and a dedicated `keycloak_postgres_data` named
volume. Do not expose its database port to the host.

- [ ] **Step 3: Add Keycloak with the import and public/network hostname**

```yaml
keycloak:
  image: quay.io/keycloak/keycloak:26.0.8
  command: start-dev --import-realm --hostname=http://keycloak.localhost:8080
  environment:
    KC_BOOTSTRAP_ADMIN_USERNAME: local-keycloak-admin
    KC_BOOTSTRAP_ADMIN_PASSWORD: local-keycloak-admin-password
    KC_DB: postgres
    KC_DB_URL_HOST: keycloak-postgres
    KC_DB_URL_DATABASE: keycloak
    KC_DB_USERNAME: keycloak
    KC_DB_PASSWORD: local-keycloak-db-password
    KC_HEALTH_ENABLED: "true"
  ports:
    - "8080:8080"
  volumes:
    - ./infra/keycloak:/opt/keycloak/data/import:ro
  networks:
    default:
      aliases:
        - keycloak.localhost
```

Add a readiness health check against Keycloak’s management health endpoint and
make the app service depend on `keycloak` being healthy in addition to its
existing PostgreSQL dependency.

- [ ] **Step 4: Run the Compose and discovery checks**

Run:

```bash
docker compose config --quiet
docker compose up -d --build
docker compose ps
curl --fail --silent http://keycloak.localhost:8080/realms/internal/.well-known/openid-configuration
curl --fail --silent http://localhost:3000/api/health
```

Expected: both databases and Keycloak are healthy; discovery identifies
`http://keycloak.localhost:8080/realms/internal` as issuer; app health returns
`{"status":"ok"}`.

- [ ] **Step 5: Commit the Compose task**

```bash
git add compose.yaml
git commit -m "feat: run local Keycloak in Compose"
```

### Task 3: Align local configuration and developer documentation

**Files:**
- Modify: `.env.example`
- Modify: `README.md`
- Test: `lib/config.test.ts`

**Interfaces:**
- Consumes: Keycloak service issuer and client secret from Tasks 1 and 2.
- Produces: copyable local configuration that points NextAuth at the imported realm.

- [ ] **Step 1: Write the failing local issuer configuration test**

```ts
it("accepts the local Keycloak issuer used by Compose", () => {
  expect(loadConfig({ ...baseEnvironment,
    APP_ENVIRONMENT: "local",
    KEYCLOAK_ISSUER: "http://keycloak.localhost:8080/realms/internal"
  }).keycloakIssuer).toBe("http://keycloak.localhost:8080/realms/internal");
});
```

- [ ] **Step 2: Run the focused test to verify its initial result**

Run: `bunx vitest run lib/config.test.ts`

Expected: PASS if no schema change is needed; this confirms the locally scoped
HTTP issuer remains permitted only under `APP_ENVIRONMENT=local`.

- [ ] **Step 3: Update local configuration and docs**

Set the sample issuer to `http://keycloak.localhost:8080/realms/internal` and
the sample client secret to `local-keycloak-client-secret`. Document:

- `docker compose up --build` starts app, app PostgreSQL, Keycloak, and Keycloak PostgreSQL.
- Keycloak admin console: `http://keycloak.localhost:8080/admin`.
- The three test usernames/passwords and their mapped application roles.
- The local-only admin-console credentials.
- How to reset only local identity state: `docker compose down -v`.
- That all listed credentials are development fixtures and cannot be deployed.

- [ ] **Step 4: Run the focused config test**

Run: `bunx vitest run lib/config.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit configuration and documentation**

```bash
git add .env.example README.md lib/config.test.ts
git commit -m "docs: document local Keycloak login"
```

### Task 4: Verify the end-to-end local OIDC flow

**Files:**
- Modify: `docs/superpowers/specs/2026-08-06-local-keycloak-design.md` only if verification reveals a necessary design correction.
- Test: `infra/keycloak/internal-realm.test.ts`, full Bun suite, Docker Compose, Chrome debugging session.

**Interfaces:**
- Consumes: imported realm, Compose service network alias, local `.env` issuer, and the app’s existing `resource_access.s3-browser.roles` claim reader.
- Produces: manual proof that each seeded account reaches the app with the correct role.

- [ ] **Step 1: Start a clean local identity state**

Run:

```bash
docker compose down -v
docker compose up -d --build
docker compose ps
```

Expected: Keycloak performs the realm import once on the fresh
`keycloak_postgres_data` volume and reports healthy.

- [ ] **Step 2: Verify issuer discovery and app readiness**

Run:

```bash
curl --fail --silent http://keycloak.localhost:8080/realms/internal/.well-known/openid-configuration
curl --fail --silent http://localhost:3000/api/health
```

Expected: discovery has the configured issuer; application health returns
`{"status":"ok"}`.

- [ ] **Step 3: Verify one login per role in Chrome debugging**

For each user, open `http://localhost:3000`, select **Sign in with Keycloak**,
authenticate using its development fixture password, then verify the role badge
shown in the S3 Browser UI matches:

```text
s3-readonly  -> readonly
s3-readwrite -> readwrite
s3-admin     -> admin
```

Clear the browser session between users by signing out or clearing the local
browser profile cookies. Do not record screenshots containing passwords or
session cookies.

- [ ] **Step 4: Run the full automated verification suite**

Run:

```bash
bun run test
bun run lint
bun run typecheck
bun run build
```

Expected: all commands exit successfully.

- [ ] **Step 5: Commit end-to-end verification artifacts only if source changes were needed**

```bash
git status --short
git add docs/superpowers/specs/2026-08-06-local-keycloak-design.md
git commit -m "docs: verify local Keycloak integration"
```

Do not create an empty commit when no source or documentation changes are
required.
