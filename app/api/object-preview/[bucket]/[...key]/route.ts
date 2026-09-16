import { Readable } from "node:stream";

import { auditRepository } from "@/db/audit";
import { transferRepository } from "@/db/transfers";
import { requireCapability } from "@/lib/auth/require";
import { loadConfig } from "@/lib/config";
import { genericErrorResponse } from "@/lib/http/route";
import { beginAuditedStream } from "@/lib/operations/with-audit";
import { getS3Service } from "@/lib/s3/client";

export const runtime = "nodejs";

type Context = { params: Promise<{ bucket: string; key: string[] }> };

export async function GET(request: Request, { params }: Context): Promise<Response> {
  try {
    const { bucket, key: keySegments } = await params;
    const key = keySegments.join("/");
    const config = loadConfig();
    const actor = await requireCapability("download");
    const lease = await transferRepository.acquire({ actorSub: actor.sub, type: "download", limit: config.transferLimit });
    if (!lease.granted) return Response.json({ error: "Download transfer limit reached" }, { status: 429, headers: { "Cache-Control": "no-store" } });

    let body: Readable | undefined;
    let finalize: ((error?: unknown) => Promise<void>) | undefined;
    try {
      const streamOperation = await beginAuditedStream(
        {
          audit: auditRepository,
          context: {
            actorSub: actor.sub,
            username: actor.username,
            email: actor.email,
            action: "preview",
            bucket,
            objectKey: key,
            correlationId: crypto.randomUUID(),
            sourceIp: request.headers.get("x-forwarded-for"),
            userAgent: request.headers.get("user-agent")
          }
        },
        () => getS3Service().getPreviewObject(bucket, key)
      );
      const preview = streamOperation.result;
      body = preview.body as Readable;
      const stream = body;
      let finalized = false;
      const finish = async (error?: unknown) => {
        if (finalized) return;
        finalized = true;
        await Promise.allSettled([streamOperation.recordOutcome(error), transferRepository.release(lease.id)]);
      };
      finalize = finish;
      stream.once("end", () => void finish()).once("error", (error) => void finish(error)).once("close", () => void finish(stream.readableEnded ? undefined : new Error("StreamClosed")));

      return new Response(Readable.toWeb(body) as ReadableStream, { headers: preview.headers });
    } catch (error) {
      if (finalize) {
        const completion = finalize(error);
        body?.destroy();
        await completion;
      } else {
        await transferRepository.release(lease.id);
      }
      throw error;
    }
  } catch (error) {
    return genericErrorResponse(error);
  }
}
