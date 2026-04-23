/**
 * GET /.well-known/agent.json
 *
 * The Super Agent shell polls this at registry load to discover the
 * Food Agent's capabilities, SLA, and PII scope. Must be cacheable
 * (headers below) and CORS-clean — the shell runs on a different
 * origin.
 *
 * Manifest URLs depend on PUBLIC_BASE_URL; build per-request rather
 * than at module-load time so Vercel previews and env overrides work
 * without rebuilding the Next bundle.
 */

import { NextResponse } from "next/server";

import { buildManifest } from "@/lib/manifest";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const manifest = buildManifest();
    return NextResponse.json(manifest, {
      status: 200,
      headers: {
        "cache-control": "public, max-age=60, s-maxage=300",
        "access-control-allow-origin": "*",
      },
    });
  } catch (err) {
    // defineManifest() throws on schema failure. 500 with a short
    // reason so operator logs can pinpoint the bad field.
    const message = err instanceof Error ? err.message : "manifest build failed";
    return NextResponse.json(
      { error: "manifest_invalid", message },
      { status: 500 },
    );
  }
}
