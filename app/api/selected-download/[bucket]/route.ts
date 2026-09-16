import { Readable } from "node:stream";

import { auditRepository } from "@/db/audit";
import { transferRepository } from "@/db/transfers";
import { requireCapability } from "@/lib/auth/require";
import { loadConfig } from "@/lib/config";
import { genericErrorResponse } from "@/lib/http/route";
import { beginAuditedStream } from "@/lib/operations/with-audit";
import { assertTrustedMutationOrigin } from "@/lib/security/origin";
import { getS3Service } from "@/lib/s3/client";

export const runtime = "nodejs";

type Context = { params: Promise<{ bucket: string }> };

async function selectedKeys(request: Request): Promise<string[] | undefined> {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return undefined;
  }

  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1) return undefined;

  const { keys } = body as { keys?: unknown };
  if (!Array.isArray(keys) || keys.some((key) => typeof key !== "string")) return undefined;

  return keys;
}

function invalidSelectionResponse(): Response {
  return Response.json({ error: "Select one or more unique objects" }, { status: 400, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request, { params }: Context): Promise<Response> {
  try {
    const keys = await selectedKeys(request);
    if (!keys) return invalidSelectionResponse();

    const { bucket } = await params;
    const config = loadConfig();
    assertTrustedMutationOrigin(request, config.applicationOrigin);
    const actor = await requireCapability("download");
    const lease = await transferRepository.acquire({ actorSub: actor.sub, type: "download", limit: config.transferLimit });
    if (!lease.granted) return Response.json({ error: "Download transfer limit reached" }, { status: 429, headers: { "Cache-Control": "no-store" } });

    let stream: Readable | undefined;
    let finalize: ((error?: unknown) => Promise<void>) | undefined;
    try {
      const streamOperation = await beginAuditedStream(
        {
          audit: auditRepository,
          context: {
            actorSub: actor.sub,
            username: actor.username,
            email: actor.email,
            action: "selected-download",
            bucket,
            prefix: `selected:${keys.length}`,
            correlationId: crypto.randomUUID(),
            sourceIp: request.headers.get("x-forwarded-for"),
            userAgent: request.headers.get("user-agent")
          }
        },
        () => getS3Service().getSelectedArchive(bucket, keys)
      );
      const archive = streamOperation.result;
      stream = archive.stream;
      let finalized = false;
      const finish = async (error?: unknown) => {
        if (finalized) return;
        finalized = true;
        await Promise.allSettled([
          streamOperation.recordOutcome(error, { objectCount: archive.objectCount, totalSize: archive.totalSize }),
          transferRepository.release(lease.id)
        ]);
      };
      finalize = finish;
      archive.stream.once("end", () => void finish()).once("error", (error) => void finish(error)).once("close", () => void finish(archive.stream.readableEnded ? undefined : new Error("StreamClosed")));

      return new Response(Readable.toWeb(archive.stream) as ReadableStream, {
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": 'attachment; filename="selected-objects.zip"',
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff"
        }
      });
    } catch (error) {
      if (finalize) {
        const completion = finalize(error);
        stream?.destroy();
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
