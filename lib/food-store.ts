/**
 * In-memory order store for the agent-to-agent surface.
 *
 * Deliberately separate from `lib/storage.ts` (which is session-keyed for
 * the PWA's voice-chat flow). The agent surface is called by the Super
 * Agent orchestrator with no notion of a "session" — orders are keyed
 * only by `order_id`, and cancellation has to work from the order_id
 * alone.
 *
 * Process-local Map — survives multiple requests in the same server
 * instance but NOT across deploys/cold starts. That's fine for the mock
 * phase: the Saga rollback window is seconds, not days. When we wire a
 * real food provider (MealMe/Olo), swap this for a Neon table with the
 * same function signatures; no route changes needed.
 *
 * Two guarantees the Saga depends on:
 *
 *   1. `placeOrder` with a repeat `idempotency_key` returns the same
 *      order row (not a second insert). The orchestrator retries on
 *      network flakes; we must not double-charge.
 *   2. `cancelOrder` on an already-cancelled order returns the SAME
 *      terminal state with `already_cancelled: true` — never an error.
 *      Saga rollback sweeps can retry a cancel and must converge.
 */

import { randomBytes } from "node:crypto";

import type { Cart } from "./types";

/** Order as the agent surface exposes it. */
export interface FoodOrder {
  order_id: string;
  status: "placed" | "cancelled";
  cart: Cart;
  delivery_address: string;
  total_amount: string; // decimal string ("27.48")
  total_currency: "USD";
  placed_at: string; // ISO 8601
  estimated_delivery_at: string; // ISO 8601
  cancelled_at?: string;
  refund_amount?: string;
  refund_currency?: "USD";
}

export interface PlaceOrderInput {
  cart: Cart;
  delivery_address: string;
  /** Stripe PaymentMethod id — NOT charged in mock; captured for parity with real flow. */
  payment_method_id: string;
  /** Orchestrator-stamped idempotency key. Same key → same order. */
  idempotency_key?: string | null;
}

/** Keyed by order_id for the primary lookup. */
const orders = new Map<string, FoodOrder>();
/** Secondary index: idempotency_key → order_id. */
const byIdempotencyKey = new Map<string, string>();

export function placeOrder(input: PlaceOrderInput): FoodOrder {
  if (input.idempotency_key) {
    const existingId = byIdempotencyKey.get(input.idempotency_key);
    if (existingId) {
      const existing = orders.get(existingId);
      if (existing) return existing;
    }
  }

  const order_id = `ord_${randomBytes(10).toString("hex")}`;
  const now = new Date();
  const eta = new Date(now.getTime() + input.cart.eta_minutes * 60_000);

  // Decimal string so the wire shape matches what a real payment
  // provider returns and avoids float drift in JSON.
  const total_amount = (input.cart.total_cents / 100).toFixed(2);

  const order: FoodOrder = {
    order_id,
    status: "placed",
    cart: input.cart,
    delivery_address: input.delivery_address,
    total_amount,
    total_currency: "USD",
    placed_at: now.toISOString(),
    estimated_delivery_at: eta.toISOString(),
  };

  orders.set(order_id, order);
  if (input.idempotency_key) {
    byIdempotencyKey.set(input.idempotency_key, order_id);
  }
  return order;
}

export type CancelResult =
  | { ok: true; order: FoodOrder; already_cancelled: boolean }
  | { ok: false; reason: "not_found" };

export function cancelOrder(order_id: string): CancelResult {
  const order = orders.get(order_id);
  if (!order) return { ok: false, reason: "not_found" };

  if (order.status === "cancelled") {
    // Idempotent repeat — same terminal state, flagged so the Saga can
    // tell retry-repeats apart from first cancellations in its audit log.
    return { ok: true, order, already_cancelled: true };
  }

  const cancelled: FoodOrder = {
    ...order,
    status: "cancelled",
    cancelled_at: new Date().toISOString(),
    // Mock: full refund. Real provider may return partial depending on
    // kitchen acceptance state; compensation-kind is declared
    // "best-effort" so the Saga tolerates either.
    refund_amount: order.total_amount,
    refund_currency: "USD",
  };
  orders.set(order_id, cancelled);
  return { ok: true, order: cancelled, already_cancelled: false };
}

export function getOrder(order_id: string): FoodOrder | null {
  return orders.get(order_id) ?? null;
}
