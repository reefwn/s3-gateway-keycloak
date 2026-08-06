import { getPool } from "@/db/client";
import { loadConfig } from "@/lib/config";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  try {
    loadConfig();
    await getPool().query("SELECT 1");

    return Response.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ status: "not ready" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
