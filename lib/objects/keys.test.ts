import { describe, expect, it } from "vitest";

import { assertSafeObjectKey, toPrefixMarkerKey } from "@/lib/objects/keys";

describe("assertSafeObjectKey", () => {
  it("preserves a valid Unicode S3 object key", () => {
    expect(assertSafeObjectKey("reports/สรุปเดือน-01.pdf")).toBe("reports/สรุปเดือน-01.pdf");
  });

  it("rejects empty and control-character keys", () => {
    expect(() => assertSafeObjectKey("")).toThrow(/empty/i);
    expect(() => assertSafeObjectKey("reports/\u0000secret.txt")).toThrow(/control/i);
  });
});

describe("toPrefixMarkerKey", () => {
  it("adds exactly one trailing slash", () => {
    expect(toPrefixMarkerKey("reports/2026")).toBe("reports/2026/");
    expect(toPrefixMarkerKey("reports/2026/")).toBe("reports/2026/");
  });
});
