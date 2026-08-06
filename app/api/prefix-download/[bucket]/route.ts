import { Readable } from "node:stream";

import { auditRepository } from "@/db/audit";
import { requireCapability } from "@/lib/auth/require";
import { loadConfig } from "@/lib/config";
import { transferRepository } from "@/db/transfers";
import { genericErrorResponse } from "@/lib/http/route";
import { beginAuditedStream } from "@/lib/operations/with-audit";
import { getS3Service } from "@/lib/s3/client";

export const runtime = "nodejs";

export async function GET(request: Request, { params }: { params: Promise<{ bucket: string }> }): Promise<Response> {
  try {
    const { bucket } = await params;
    const prefix = new URL(request.url).searchParams.get("prefix") ?? "";
    const config = loadConfig();
    const actor = await requireCapability("download");
    const lease = await transferRepository.acquire({ actorSub: actor.sub, type: "download", limit: config.transferLimit });
    if (!lease.granted) return Response.json({ error: "Download transfer limit reached" }, { status: 429, headers: { "Cache-Control": "no-store" } });

    try {
      const context = { actorSub: actor.sub, username: actor.username, email: actor.email, action: "prefix-download", bucket, prefix, correlationId: crypto.randomUUID(), sourceIp: request.headers.get("x-forwarded-for"), userAgent: request.headers.get("user-agent") };
      const streamOperation = await beginAuditedStream(
        {
          audit: auditRepository,
          context
        },
        () => getS3Service().getPrefixArchive(bucket, prefix)
      );
      const archive = streamOperation.result;
      let finalized = false;
      const finalize = (error?: unknown) => {
        if (finalized) return;
        finalized = true;
        void Promise.allSettled([
          streamOperation.recordOutcome(error, { objectCount: archive.objectCount, totalSize: archive.totalSize }),
          transferRepository.release(lease.id)
        ]);
      };
      archive.stream.once("end", () => finalize()).once("error", finalize).once("close", () => finalize(archive.stream.readableEnded ? undefined : new Error("StreamClosed")));
      return new Response(Readable.toWeb(archive.stream) as ReadableStream, { headers: { "Content-Type": "application/zip", "Content-Disposition": 'attachment; filename="prefix-download.zip"', "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
    } catch (error) {
      await transferRepository.release(lease.id);
      throw error;
    }
  } catch (error) {
    return genericErrorResponse(error);
  }
}
