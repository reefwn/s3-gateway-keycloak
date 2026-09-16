// @vitest-environment node

import { describe, expect, it } from "vitest";

import { genericErrorResponse } from "@/lib/http/route";
import { InvalidArchiveSelectionError, PreviewNotSupportedError } from "@/lib/s3/service";

describe("genericErrorResponse", () => {
  it("maps unsupported previews to a no-store generic 415 response", async () => {
    const response = genericErrorResponse(new PreviewNotSupportedError());

    expect(response.status).toBe(415);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ error: "Preview is not supported for this object" });
  });

  it("maps invalid selected archives to a no-store generic 400 response", async () => {
    const response = genericErrorResponse(new InvalidArchiveSelectionError());

    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ error: "Select one or more unique objects" });
  });
});
