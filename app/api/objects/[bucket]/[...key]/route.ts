import { Readable } from "node:stream";

import { auditRepository } from "@/db/audit";
import { requireCapability } from "@/lib/auth/require";
import { loadConfig } from "@/lib/config";
import { transferRepository } from "@/db/transfers";
import { genericErrorResponse } from "@/lib/http/route";
import { beginAuditedStream, runAuditedOperation } from "@/lib/operations/with-audit";
import { assertTrustedMutationOrigin } from "@/lib/security/origin";
import { getS3Service } from "@/lib/s3/client";

export const runtime = "nodejs";

type Context = { params: Promise<{ bucket: string; key: string[] }> };

function contextFor(request: Request, actor: Awaited<ReturnType<typeof requireCapability>>, action: string, bucket: string, objectKey: string) {
  return {
    actorSub: actor.sub,
    username: actor.username,
    email: actor.email,
    action,
    bucket,
    objectKey,
    correlationId: crypto.randomUUID(),
    sourceIp: request.headers.get("x-forwarded-for"),
    userAgent: request.headers.get("user-agent")
  };
}

export async function GET(request: Request, { params }: Context): Promise<Response> {
  try {
    const { bucket, key: keySegments } = await params;
    const key = keySegments.join("/");
    const config = loadConfig();
    const actor = await requireCapability("download");
    const lease = await transferRepository.acquire({ actorSub: actor.sub, type: "download", limit: config.transferLimit });
    if (!lease.granted) return Response.json({ error: "Download transfer limit reached" }, { status: 429, headers: { "Cache-Control": "no-store" } });

    try {
      const streamOperation = await beginAuditedStream(
        { audit: auditRepository, context: contextFor(request, actor, "download", bucket, key) },
        () => getS3Service().getObject(bucket, key)
      );
      const download = streamOperation.result;
      const body = download.body as Readable;
      let finalized = false;
      const finalize = (error?: unknown) => {
        if (finalized) return;
        finalized = true;
        void Promise.allSettled([streamOperation.recordOutcome(error), transferRepository.release(lease.id)]);
      };
      body.once("end", () => finalize()).once("error", finalize).once("close", () => finalize(body.readableEnded ? undefined : new Error("StreamClosed")));

      return new Response(Readable.toWeb(body) as ReadableStream, { headers: download.headers });
    } catch (error) {
      await transferRepository.release(lease.id);
      throw error;
    }
  } catch (error) {
    return genericErrorResponse(error);
  }
}

export async function DELETE(request: Request, { params }: Context): Promise<Response> {
  try {
    const { bucket, key: keySegments } = await params;
    const key = keySegments.join("/");
    const config = loadConfig();
    assertTrustedMutationOrigin(request, config.applicationOrigin);
    const actor = await requireCapability("delete");
    if (request.headers.get("x-s3-confirm-key") !== key) {
      return Response.json({ error: "Exact object key confirmation is required" }, { status: 400, headers: { "Cache-Control": "no-store" } });
    }

    await runAuditedOperation(
      { audit: auditRepository, context: contextFor(request, actor, "delete", bucket, key) },
      () => getS3Service().deleteObject(bucket, key)
    );

    return Response.json({ status: "deleted" }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return genericErrorResponse(error);
  }
}
