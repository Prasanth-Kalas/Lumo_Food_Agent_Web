/**
 * GET /api/health
 *
 * The Super Agent shell polls this on a cadence (HEALTH_POLL_MS,
 * default 10s) and feeds the rolling score into its circuit breaker.
 * Keep this cheap — no upstream fan-out on the happy path. When we
 * wire a real provider (MealMe/Olo/Stripe), cache the last probe
 * result in a module-level ring buffer and aggregate here.
 *
 * Status conventions (defined in @lumo/agent-sdk/health):
 *   - "ok"       → HTTP 200, within SLA, all upstreams healthy
 *   - "degraded" → HTTP 200, can still serve but something's wobbly
 *   - "down"     → HTTP 503, cannot serve; breaker opens
 */

import { healthResponse } from "@lumo/agent-sdk";

export const dynamic = "force-dynamic";

export async function GET() {
  // Mock phase — no real upstreams yet. Always report ok. Real
  // probes land alongside the provider integration.
  return healthResponse({
    status: "ok",
    agent_id: "food",
    version: "0.1.0",
  });
}
