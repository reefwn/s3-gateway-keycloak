import { Readable } from "node:stream";

import { auditRepository } from "@/db/audit";
import { getCurrentActor, requireCapability } from "@/lib/auth/require";
import { loadConfig } from "@/lib/config";
import { genericErrorResponse } from "@/lib/http/route";
import { runAuditedOperation } from "@/lib/operations/with-audit";
import { assertTrustedMutationOrigin } from "@/lib/security/origin";
import { getS3Service } from "@/lib/s3/client";
import { transferRepository } from "@/db/transfers";

export const runtime = "nodejs";

type Context = { params: Promise<{ bucket: string }> };

function auditContext(request: Request, actor: Awaited<ReturnType<typeof getCurrentActor>>, action: string, bucket: string, objectKey?: string) {
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
    const { bucket } = await params;
    const actor = await requireCapability("list");
    const prefix = new URL(request.url).searchParams.get("prefix") ?? "";
    const continuationToken = new URL(request.url).searchParams.get("continuationToken") ?? undefined;
    const listing = await runAuditedOperation(
      { audit: auditRepository, context: auditContext(request, actor, "list-objects", bucket, prefix) },
      () => getS3Service().listObjects(bucket, prefix, continuationToken)
    );

    return Response.json(listing, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return genericErrorResponse(error);
  }
}

export async function POST(request: Request, { params }: Context): Promise<Response> {
  try {
    const { bucket } = await params;
    const config = loadConfig();
    assertTrustedMutationOrigin(request, config.applicationOrigin);
    const form = await request.formData();
    const action = form.get("action");

    if (action === "create-prefix") {
      const actor = await requireCapability("createPrefix");
      const prefix = form.get("prefix");
      if (typeof prefix !== "string") return Response.json({ error: "Prefix is required" }, { status: 400, headers: { "Cache-Control": "no-store" } });
      await runAuditedOperation(
        { audit: auditRepository, context: auditContext(request, actor, "create-prefix", bucket, prefix) },
        () => getS3Service().createPrefixMarker(bucket, prefix)
      );
      return Response.json({ status: "created" }, { status: 201, headers: { "Cache-Control": "no-store" } });
    }

    const actor = await requireCapability("upload");
    const file = form.get("file");
    const key = form.get("key");
    if (!(file instanceof File) || typeof key !== "string") return Response.json({ error: "File and key are required" }, { status: 400, headers: { "Cache-Control": "no-store" } });
    const lease = await transferRepository.acquire({ actorSub: actor.sub, type: "upload", limit: config.transferLimit });
    if (!lease.granted) return Response.json({ error: "Upload transfer limit reached" }, { status: 429, headers: { "Cache-Control": "no-store" } });

    try {
      await runAuditedOperation(
        { audit: auditRepository, context: auditContext(request, actor, "upload", bucket, key) },
        () => getS3Service().putObject(bucket, key, Readable.fromWeb(file.stream() as never), file.type, file.size, form.get("overwrite") === "true")
      );
    } finally {
      await transferRepository.release(lease.id);
    }

    return Response.json({ status: "uploaded" }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return genericErrorResponse(error);
  }
}
