import { redirect } from "next/navigation";

import { S3Browser } from "@/components/s3-browser";
import { getCurrentActor } from "@/lib/auth/require";
import { loadConfig } from "@/lib/config";

async function AuthenticatedBrowser() {
  const [actor, config] = await Promise.all([getCurrentActor(), Promise.resolve(loadConfig())]);

  return <S3Browser actor={actor} buckets={config.allowedBuckets} />;
}

export default async function HomePage() {
  try {
    return await AuthenticatedBrowser();
  } catch {
    redirect("/api/auth/signin?callbackUrl=/");
  }
}
