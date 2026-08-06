import { AuditOutcomePersistenceError } from "@/lib/operations/with-audit";
import { AccessDeniedError } from "@/lib/auth/require";
import { AllowedBucketError, ArchiveLimitError, ObjectTooLargeError } from "@/lib/s3/service";

export function genericErrorResponse(error: unknown): Response {
  if (error instanceof AccessDeniedError || error instanceof AllowedBucketError) {
    return Response.json({ error: "Not found or not permitted" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  }

  if (error instanceof ObjectTooLargeError) {
    return Response.json({ error: error.message }, { status: 413, headers: { "Cache-Control": "no-store" } });
  }

  if (error instanceof ArchiveLimitError) {
    return Response.json({ error: error.message }, { status: 413, headers: { "Cache-Control": "no-store" } });
  }

  if (error instanceof AuditOutcomePersistenceError) {
    return Response.json({ error: "The operation outcome could not be recorded" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }

  return Response.json({ error: "Request could not be completed" }, { status: 500, headers: { "Cache-Control": "no-store" } });
}
