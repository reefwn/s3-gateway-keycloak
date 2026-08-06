import { describe, expect, it } from "vitest";

import { actorFromProfile, readClaim } from "@/lib/auth/session";

const mapping = {
  "s3-browser-admin": "admin",
  "s3-browser-readonly": "readonly"
} as const;

describe("readClaim", () => {
  it("reads a nested Keycloak claim path", () => {
    expect(
      readClaim(
        { resource_access: { "s3-browser": { roles: ["s3-browser-admin"] } } },
        "resource_access.s3-browser.roles"
      )
    ).toEqual(["s3-browser-admin"]);
  });
});

describe("actorFromProfile", () => {
  it("creates an actor from immutable identity and one mapped role", () => {
    expect(
      actorFromProfile(
        {
          sub: "user-123",
          preferred_username: "alex",
          email: "alex@example.test",
          resource_access: { "s3-browser": { roles: ["s3-browser-admin"] } }
        },
        "resource_access.s3-browser.roles",
        mapping
      )
    ).toEqual({ sub: "user-123", username: "alex", email: "alex@example.test", role: "admin" });
  });

  it("returns null when a profile is missing identity or an unambiguous role", () => {
    expect(actorFromProfile({ sub: "user-123" }, "roles", mapping)).toBeNull();
    expect(
      actorFromProfile(
        { sub: "user-123", roles: ["s3-browser-admin", "s3-browser-readonly"] },
        "roles",
        mapping
      )
    ).toBeNull();
  });
});
