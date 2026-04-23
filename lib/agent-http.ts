/**
 * Shared HTTP helpers for the agent-to-agent tool routes.
 *
 * Named `agent-http.ts` (not `http.ts`) to avoid shadowing Next's own
 * request plumbing and to make the intent obvious at import sites:
 * these helpers are for the `/api/tools/*` surface that the Super Agent
 * orchestrator calls over HTTP — distinct from the PWA's `/api/chat`
 * AI-SDK flow.
 *
 * Stable error envelope so the shell's router can surface `error` codes
 * to Claude without parsing free-form `message` strings.
 */

import { NextResponse } from "next/server";
import type { ZodError } from "zod";

export function errorResponse(
  error: string,
  status: number,
  message?: string,
  details?: Record<string, unknown>,
) {
  return NextResponse.json(
    {
      error,
      ...(message ? { message } : {}),
      ...(details ? { details } : {}),
    },
    { status },
  );
}

export function badRequestFromZod(err: ZodError) {
  return errorResponse(
    "bad_request",
    400,
    "Request body failed validation.",
    {
      issues: err.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
        code: i.code,
      })),
    },
  );
}

/**
 * Drop SDK envelope keys (anything prefixed with `_`) before domain
 * validation. The shell router merges `_pii`, `_ctx`, and future envelope
 * fields into tool bodies so agents don't have to parse them off custom
 * headers. Our domain Zod schemas use `.strict()` to catch hallucinated
 * fields, so without this pre-strip every real request would 400 on the
 * envelope keys. Underscore prefix is the protocol convention — domain
 * fields never start with `_`, envelope fields always do.
 */
export function stripEnvelopeKeys(body: unknown): unknown {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return body;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    if (k.startsWith("_")) continue;
    out[k] = v;
  }
  return out;
}
