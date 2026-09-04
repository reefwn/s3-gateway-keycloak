import { describe, expect, it } from "vitest";

import { can, resolveRole } from "@/lib/auth/roles";

const roleMapping = {
  "s3-browser-admin": "admin",
  "s3-browser-readwrite": "readwrite",
  "s3-browser-readonly": "readonly"
} as const;

describe("resolveRole", () => {
  it("resolves a single mapped role", () => {
    expect(resolveRole(["s3-browser-readwrite"], roleMapping)).toBe("readwrite");
  });

  it("rejects an absent or unmapped claim", () => {
    expect(resolveRole(undefined, roleMapping)).toBeNull();
    expect(resolveRole(["unrelated"], roleMapping)).toBeNull();
  });

  it("resolves to the highest-privilege role when multiple roles match", () => {
    expect(resolveRole(["s3-browser-admin", "s3-browser-readonly"], roleMapping)).toBe("admin");
    // Order in the claim shouldn't matter — same pair, reversed.
    expect(resolveRole(["s3-browser-readonly", "s3-browser-admin"], roleMapping)).toBe("admin");
    expect(resolveRole(["s3-browser-readwrite", "s3-browser-admin"], roleMapping)).toBe("admin");
    expect(resolveRole(["s3-browser-readonly", "s3-browser-readwrite"], roleMapping)).toBe("readwrite");
  });

  it("resolves to admin when a user holds all three roles", () => {
    expect(
      resolveRole(["s3-browser-readonly", "s3-browser-readwrite", "s3-browser-admin"], roleMapping)
    ).toBe("admin");
  });

  it("ignores unmapped roles when resolving among multiple matches", () => {
    expect(resolveRole(["unrelated", "s3-browser-readwrite", "s3-browser-admin"], roleMapping)).toBe("admin");
  });
});

describe("can", () => {
  it("allows readonly operations for every role", () => {
    expect(can("readonly", "list")).toBe(true);
    expect(can("readwrite", "download")).toBe(true);
    expect(can("admin", "download")).toBe(true);
  });

  it("limits writes and deletes to their approved roles", () => {
    expect(can("readonly", "upload")).toBe(false);
    expect(can("readwrite", "upload")).toBe(true);
    expect(can("readwrite", "delete")).toBe(false);
    expect(can("admin", "delete")).toBe(true);
  });
});
