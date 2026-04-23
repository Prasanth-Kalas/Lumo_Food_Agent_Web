/**
 * POST /api/tools/food_price_cart
 *
 * READ TOOL. Cost-tier low, no PII, no confirmation gate.
 * Prices the requested cart and attaches a `_lumo_summary` with the
 * sha256 hash the orchestrator MUST echo back to food_place_order.
 *
 * This is where the confirmation contract originates: the shell
 * shows the user exactly the cart this route returns, captures their
 * yes/no, and then posts the same cart + summary_hash to the order
 * tool. The server re-derives the hash from the posted cart; if the
 * shell tampered with prices or quantities after confirmation, the
 * hashes diverge and the money tool 409s.
 *
 * `attachSummary({kind: "structured-cart"})` is the SDK primitive
 * that both stamps the `_lumo_summary` envelope and does the stable
 * hashing — no custom hashing here.
 */

import { NextResponse } from "next/server";
import { attachSummary } from "@lumo/agent-sdk";
import { z } from "zod";

import {
  badRequestFromZod,
  errorResponse,
  stripEnvelopeKeys,
} from "@/lib/agent-http";
import { canonicalCartSummary, priceCart } from "@/lib/food-cart";

const LineSchema = z
  .object({
    item_id: z.string().min(1),
    quantity: z.number().int().min(1).max(50),
    modifiers: z.record(z.string()).optional(),
    notes: z.string().max(256).optional(),
  })
  .strict();

const BodySchema = z
  .object({
    restaurant_id: z.string().min(1),
    lines: z.array(LineSchema).min(1).max(50),
  })
  .strict();

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return errorResponse("bad_request", 400, "Body must be valid JSON.");
  }

  const parsed = BodySchema.safeParse(stripEnvelopeKeys(raw));
  if (!parsed.success) return badRequestFromZod(parsed.error);

  const result = priceCart(parsed.data.restaurant_id, parsed.data.lines);

  if (result.kind === "err") {
    // Exhaustive switch: the never-default keeps us honest when
    // priceCart grows a new error reason.
    switch (result.reason) {
      case "restaurant_not_found":
        return errorResponse(
          "restaurant_not_found",
          404,
          "No restaurant with that id.",
        );
      case "item_not_found":
        return errorResponse(
          "item_not_found",
          404,
          `Item ${result.item_id} does not belong to this restaurant.`,
          { item_id: result.item_id },
        );
      case "restaurant_closed":
        return errorResponse(
          "restaurant_closed",
          409,
          "Restaurant is not currently accepting orders.",
        );
      default: {
        const _exhaustive: never = result;
        void _exhaustive;
        return errorResponse("internal_error", 500);
      }
    }
  }

  const { cart } = result;

  // Attach the canonical summary. The SDK:
  //   - stamps { _lumo_summary: { kind, payload, hash } } onto the body
  //   - stable-stringifies payload + sha256 for a deterministic hash
  // The orchestrator strips `_lumo_summary` to show the user and
  // echoes `hash` back as `summary_hash` on food_place_order.
  const body = attachSummary(
    { cart },
    {
      kind: "structured-cart",
      payload: canonicalCartSummary(cart),
    },
  );

  return NextResponse.json(body, {
    status: 200,
    headers: { "cache-control": "no-store" },
  });
}
