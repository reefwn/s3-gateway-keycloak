import { auditRepository } from "@/db/audit";
import { getCurrentActor } from "@/lib/auth/require";
import { loadConfig } from "@/lib/config";
import { genericErrorResponse } from "@/lib/http/route";
import { runAuditedOperation } from "@/lib/operations/with-audit";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  try {
    const actor = await getCurrentActor();
    const config = loadConfig();
    const buckets = await runAuditedOperation(
      {
        audit: auditRepository,
        context: {
          actorSub: actor.sub,
          username: actor.username,
          email: actor.email,
          action: "list-buckets",
          correlationId: crypto.randomUUID(),
          sourceIp: request.headers.get("x-forwarded-for"),
          userAgent: request.headers.get("user-agent")
        }
      },
      async () => config.allowedBuckets
    );

    return Response.json({ buckets }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return genericErrorResponse(error);
  }
}
