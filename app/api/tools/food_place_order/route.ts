/**
 * POST /api/tools/food_place_order
 *
 * MONEY TOOL. Pairs with food_cancel_order for Saga rollback.
 *
 * SDK invariants validated at registry load:
 *   - cost-tier: "money"
 *   - requires-confirmation: "structured-cart"  (confirmation gate)
 *   - x-lumo-cancels: food_cancel_order         (bidirectional pair)
 *   - pii-required includes payment_method_id + delivery_address
 *
 * The confirmation gate. The shell has already shown the user the
 * cart returned by food_price_cart (which carried a _lumo_summary
 * with sha256 hash). The shell posts that same cart here with
 * `summary_hash` and `user_confirmed: true`. We:
 *
 *   1. Re-derive canonicalCartSummary(posted_cart)
 *   2. Re-price the cart from scratch (restaurant_id + lines) to make
 *      sure the shell hasn't hand-edited prices between confirm and book
 *   3. hashSummary both — they must all agree
 *   4. Compare to `summary_hash` → 409 `confirmation_required` on miss,
 *      with `expected_summary_hash` so the orchestrator can reconfirm
 *   5. Only then call placeOrder
 *
 * Idempotency: the orchestrator MUST stamp `x-idempotency-key` on each
 * attempt. A retry of the same key returns the same order_id. We key
 * the store by the header, not by body content.
 */

import { NextResponse } from "next/server";
import { hashSummary } from "@lumo/agent-sdk";
import { z } from "zod";

import {
  badRequestFromZod,
  errorResponse,
  stripEnvelopeKeys,
} from "@/lib/agent-http";
import { canonicalCartSummary, priceCart } from "@/lib/food-cart";
import { placeOrder } from "@/lib/food-store";
import { requireToolBearer } from "@/lib/tool-auth";
import type { Cart } from "@/lib/types";

const CartLineSchema = z
  .object({
    item_id: z.string().min(1),
    name: z.string().min(1),
    quantity: z.number().int().min(1),
    unit_price_cents: z.number().int().min(0),
    selected_modifiers: z.record(z.string()),
    notes: z.string().optional(),
  })
  .strict();

const CartSchema = z
  .object({
    restaurant_id: z.string().min(1),
    restaurant_name: z.string().min(1),
    lines: z.array(CartLineSchema).min(1),
    subtotal_cents: z.number().int().min(0),
    delivery_fee_cents: z.number().int().min(0),
    service_fee_cents: z.number().int().min(0),
    tax_cents: z.number().int().min(0),
    total_cents: z.number().int().min(0),
    eta_minutes: z.number().int().min(0),
  })
  .strict();

const BodySchema = z
  .object({
    cart: CartSchema,
    delivery_address: z.string().min(1).max(512),
    payment_method_id: z.string().min(1),
    summary_hash: z
      .string()
      .length(64)
      .regex(/^[0-9a-f]{64}$/, "summary_hash must be lowercase sha256 hex."),
    user_confirmed: z.literal(true),
    contact: z
      .object({
        name: z.string().optional(),
        email: z.string().email().optional(),
        phone: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const principal = requireToolBearer(req, ["food:orders"]);
  if (principal instanceof Response) return principal;

  // Orchestrator stamps one idempotency key per attempt. Same key →
  // same order_id on retry. Header-based so it rides outside the
  // domain schema (which would otherwise change the body hash).
  const idempotency_key = req.headers.get("x-idempotency-key");

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return errorResponse("bad_request", 400, "Body must be valid JSON.");
  }

  const parsed = BodySchema.safeParse(stripEnvelopeKeys(raw));
  if (!parsed.success) return badRequestFromZod(parsed.error);
  const { cart, delivery_address, payment_method_id, summary_hash } = parsed.data;

  // -- Integrity check: server-recompute the cart from source ─────────
  // The user confirmed what food_price_cart showed them. That cart was
  // priced from mock-data on the server. If the shell re-submitted a
  // cart whose totals or line items don't match what we'd price from
  // the same restaurant_id + item_ids right now, we must refuse —
  // someone edited the body after confirmation.
  //
  // `reprice` rebuilds the cart from (restaurant_id, line item_ids +
  // quantities + modifiers) using the current menu. If the resulting
  // canonicalCartSummary hash matches both (a) the posted cart and
  // (b) the user-provided summary_hash, we know:
  //   - posted cart wasn't tampered with  (hash(posted) === hash(repriced))
  //   - user actually confirmed this cart (hash matches summary_hash)
  const repriced = priceCart(
    cart.restaurant_id,
    cart.lines.map((l) => ({
      item_id: l.item_id,
      quantity: l.quantity,
      modifiers: l.selected_modifiers,
      notes: l.notes,
    })),
  );

  if (repriced.kind === "err") {
    // Something about the posted cart no longer validates against
    // current mock-data — menu changed or restaurant closed. Either
    // way the shell must re-search and reconfirm.
    return errorResponse(
      "cart_invalid",
      409,
      "Posted cart could not be re-priced against current menu. Reprice and reconfirm.",
      { reason: repriced.reason },
    );
  }

  const serverHash = hashSummary(canonicalCartSummary(repriced.cart));
  const postedHash = hashSummary(canonicalCartSummary(cart as Cart));

  if (serverHash !== postedHash) {
    // Posted cart's totals don't match what we'd compute from the
    // same items now. Refuse and hand the shell the authoritative
    // expected hash so it can reprice + reconfirm.
    return errorResponse(
      "confirmation_required",
      409,
      "Posted cart totals diverge from server-computed totals. Reprice and reconfirm.",
      { expected_summary_hash: serverHash },
    );
  }

  if (serverHash !== summary_hash) {
    // Cart is internally consistent, but it's not the cart the user
    // confirmed. Could mean the shell swapped carts between confirm
    // and book, or the hash is stale. Force reconfirmation.
    return errorResponse(
      "confirmation_required",
      409,
      "summary_hash does not match the cart the user confirmed. Re-show the cart and capture a fresh confirmation.",
      { expected_summary_hash: serverHash },
    );
  }
  // -- End integrity check ────────────────────────────────────────────

  const order = placeOrder({
    cart: repriced.cart,
    delivery_address,
    payment_method_id,
    idempotency_key,
  });

  return NextResponse.json(
    {
      order_id: order.order_id,
      status: order.status,
      total_amount: order.total_amount,
      total_currency: order.total_currency,
      placed_at: order.placed_at,
      estimated_delivery_at: order.estimated_delivery_at,
      delivery_address: order.delivery_address,
      cart: order.cart,
    },
    { status: 200, headers: { "cache-control": "no-store" } },
  );
}
