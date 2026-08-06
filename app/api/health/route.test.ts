// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/config", () => ({ loadConfig: vi.fn() }));
vi.mock("@/db/client", () => ({ getPool: vi.fn(() => ({ query: vi.fn().mockResolvedValue({}) })) }));

import { GET } from "@/app/api/health/route";

describe("GET /api/health", () => {
  it("returns a minimal successful readiness response", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});
