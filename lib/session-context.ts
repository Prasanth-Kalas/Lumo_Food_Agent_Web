/**
 * Per-request session context (AsyncLocalStorage).
 *
 * Why this exists:
 *   Tools in lib/tools.ts used to call a hardcoded `sessionId()` that always
 *   returned "demo" — so every mobile and web user collapsed onto the same
 *   cart / order history / payment intent row. Fine for a single-user demo,
 *   fatal for anything real.
 *
 *   The /api/chat route now reads a per-device `sessionId` off the request
 *   body (falling back to "demo" for callers that don't send one yet) and
 *   runs the streamText pipeline inside AsyncLocalStorage.run(). Tool
 *   `execute()` callbacks — which the AI SDK invokes mid-stream — inherit
 *   this context automatically because Node.js propagates AsyncLocalStorage
 *   through the async task graph.
 *
 * Safety:
 *   - Defaults to "demo" when no store is set, so the web route and unit
 *     tests keep working unchanged.
 *   - No request-scoped data lives here other than the opaque session ID.
 *     Don't stuff user secrets into the store; we only need the key.
 */
import { AsyncLocalStorage } from "node:async_hooks";

interface SessionStore {
  sessionId: string;
}

const storage = new AsyncLocalStorage<SessionStore>();

export const DEFAULT_SESSION_ID = "demo";

/** Run `fn` with the given sessionId bound to the current async context. */
export function runWithSession<T>(sessionId: string, fn: () => T): T {
  const safe = sanitizeSessionId(sessionId);
  return storage.run({ sessionId: safe }, fn);
}

/**
 * Read the current request's sessionId. Falls back to "demo" when called
 * outside a `runWithSession` scope — that's deliberate so legacy callers
 * and the web route (which doesn't yet send a sessionId) keep working.
 */
export function getSessionId(): string {
  return storage.getStore()?.sessionId ?? DEFAULT_SESSION_ID;
}

/**
 * Accept UUIDs, mobile-generated hex ids, or any reasonable opaque string.
 * Reject anything empty, wildly long, or containing control chars — those
 * shouldn't reach Postgres as a primary key component.
 */
export function sanitizeSessionId(raw: unknown): string {
  if (typeof raw !== "string") return DEFAULT_SESSION_ID;
  const trimmed = raw.trim();
  if (!trimmed) return DEFAULT_SESSION_ID;
  if (trimmed.length > 128) return DEFAULT_SESSION_ID;
  // Allow [A-Za-z0-9._:-] — covers UUIDs, nanoid, and our "demo" literal.
  if (!/^[A-Za-z0-9._:-]+$/.test(trimmed)) return DEFAULT_SESSION_ID;
  return trimmed;
}
