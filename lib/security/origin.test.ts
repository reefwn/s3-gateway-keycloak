import { describe, expect, it } from "vitest";

import { OriginError, assertTrustedMutationOrigin } from "@/lib/security/origin";

describe("assertTrustedMutationOrigin", () => {
  it("accepts a same-origin mutation", () => {
    const request = new Request("https://s3-browser.internal/api/objects/reports", {
      method: "POST",
      headers: { origin: "https://s3-browser.internal" }
    });

    expect(() => assertTrustedMutationOrigin(request, "https://s3-browser.internal")).not.toThrow();
  });

  it("rejects missing and cross-origin mutation requests", () => {
    const missingOrigin = new Request("https://s3-browser.internal/api/objects/reports", { method: "POST" });
    const foreignOrigin = new Request("https://s3-browser.internal/api/objects/reports", {
      method: "POST",
      headers: { origin: "https://attacker.example" }
    });

    expect(() => assertTrustedMutationOrigin(missingOrigin, "https://s3-browser.internal")).toThrow(OriginError);
    expect(() => assertTrustedMutationOrigin(foreignOrigin, "https://s3-browser.internal")).toThrow(OriginError);
  });
});
