// @vitest-environment node

import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("production container image", () => {
  it("defines a standalone production target with migration files", async () => {
    const dockerfile = await readFile(new URL("./Dockerfile", import.meta.url), "utf8");

    expect(dockerfile).toContain("AS production");
    expect(dockerfile).toContain("/app/.next/standalone");
    expect(dockerfile).toContain("/app/db ./db");
    expect(dockerfile).toContain('CMD ["bun", "server.js"]');
  });

  it("uses valid non-secret configuration while collecting route data at build time", async () => {
    const dockerfile = await readFile(new URL("./Dockerfile", import.meta.url), "utf8");
    const buildTarget = dockerfile.slice(dockerfile.indexOf("AS build"), dockerfile.indexOf("AS production"));
    const productionTarget = dockerfile.slice(dockerfile.indexOf("AS production"));

    expect(buildTarget).toContain("DATABASE_URL=postgres://build:build@localhost:5432/build");
    expect(buildTarget).toContain("NEXTAUTH_SECRET=build-only-nextauth-secret-with-32-characters");
    expect(buildTarget).toContain("KEYCLOAK_ISSUER=https://keycloak.build.invalid/realms/internal");
    expect(buildTarget).toContain("S3_ALLOWED_BUCKETS=build-bucket");
    expect(buildTarget.indexOf("DATABASE_URL=")).toBeLessThan(buildTarget.indexOf("RUN bun run build"));
    expect(productionTarget).not.toContain("build.invalid");
  });
});
