/**
 * POST /api/tools/food_cancel_order
 *
 * CANCEL TOOL (compensating action for food_place_order).
 *
 * SDK invariants validated at registry load:
 *   - cost-tier: "free"              — provider handles any refund math;
 *                                      no net money movement we charge.
 *   - requires-confirmation: false   — CRITICAL. Saga invokes during
 *                                      rollback with no human in the loop.
 *   - x-lumo-cancel-for: food_place_order
 *                                    — bidirectional link; forward tool
 *                                      points back here via x-lumo-cancels.
 *   - compensation-kind: best-effort — kitchen may have already accepted,
 *                                      refund may be partial. Saga tolerates.
 *
 * Idempotent: repeat calls with the same order_id return 200 with
 * `already_cancelled: true` rather than erroring. Saga rollback sweeps
 * can converge without orchestrator-side dedupe.
 *
 * Unlike food_place_order this route does NOT require `summary_hash`
 * or `user_confirmed` — the forward confirmation already authorised
 * the Saga's authority to roll back.
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import {
  badRequestFromZod,
  errorResponse,
  stripEnvelopeKeys,
} from "@/lib/agent-http";
import { cancelOrder } from "@/lib/food-store";
import { requireToolBearer } from "@/lib/tool-auth";

const BodySchema = z
  .object({
    order_id: z.string().min(1),
    reason: z.string().max(512).optional(),
  })
  .strict();

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const principal = requireToolBearer(req, ["food:orders"]);
  if (principal instanceof Response) return principal;

  // Saga stamps one key per rollback attempt. Retries of the same key
  // must converge on the same terminal state — cancelOrder enforces
  // this by returning `already_cancelled: true` on the second call.
  const idempotency_key = req.headers.get("x-idempotency-key") ?? null;
  void idempotency_key; // reserved for prod persistence

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return errorResponse("bad_request", 400, "Body must be valid JSON.");
  }

  const parsed = BodySchema.safeParse(stripEnvelopeKeys(raw));
  if (!parsed.success) return badRequestFromZod(parsed.error);

  const result = cancelOrder(parsed.data.order_id);

  if (!result.ok) {
    if (result.reason === "not_found") {
      return errorResponse(
        "order_not_found",
        404,
        "No order with that id exists on this agent.",
      );
    }
  }

  // result.ok === true from here. TS can't narrow without an explicit
  // guard, so assert the positive side for readability.
  const { order, already_cancelled } = result as Extract<
    typeof result,
    { ok: true }
  >;

  return NextResponse.json(
    {
      order_id: order.order_id,
      status: order.status,
      refund_amount: order.refund_amount,
      refund_currency: order.refund_currency,
      cancelled_at: order.cancelled_at,
      already_cancelled,
    },
    { status: 200, headers: { "cache-control": "no-store" } },
  );
}
