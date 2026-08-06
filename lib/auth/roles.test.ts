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

  it("rejects an ambiguous role claim", () => {
    expect(resolveRole(["s3-browser-admin", "s3-browser-readonly"], roleMapping)).toBeNull();
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
