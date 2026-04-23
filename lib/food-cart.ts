/**
 * Cart pricing + canonical-summary helpers for the agent-to-agent surface.
 *
 * The orchestrator calls `food_price_cart` with a restaurant_id + item list,
 * receives back a priced `Cart` and a `summary_hash`, shows the user the
 * cart, and then posts the *same* priced cart back to `food_place_order`
 * along with that hash. The server re-derives the hash from the cart it
 * was sent and 409s if the two disagree — the confirmation gate.
 *
 * Pricing formula MUST match the existing PWA tool (lib/tools.ts ~L434):
 *     delivery = $2.99 flat
 *     service  = 8% of subtotal (rounded to cents)
 *     tax      = (subtotal * metro.salesTaxBps) / 10_000 (rounded to cents)
 *     total    = subtotal + delivery + service + tax
 *
 * We re-implement it here (not imported) because lib/tools.ts is bound to
 * the AI-SDK session/storage shape. The formula is the invariant, not the
 * code — if we ever change it, fix both places and add a shared helper.
 *
 * `canonicalCartSummary` is what the SDK hashes via attachSummary({
 * kind: "structured-cart" }). Keeping it a small, stable shape (no
 * transient fields like ETA that the orchestrator might mutate) makes
 * the hash reproducible across shell and server.
 */

import {
  findItemMock,
  getRestaurantByIdMock,
} from "./mock-data";
import { METROS, type Cart, type CartLine } from "./types";

/** Incoming line as the orchestrator describes it. */
export interface PriceCartLineInput {
  item_id: string;
  quantity: number;
  /** Optional modifier selections. Values are the option label, e.g. {"Crust": "Thin"}. */
  modifiers?: Record<string, string>;
  notes?: string;
}

export type PriceCartOk = { kind: "ok"; cart: Cart };
export type PriceCartErr =
  | { kind: "err"; reason: "restaurant_not_found" }
  | { kind: "err"; reason: "item_not_found"; item_id: string }
  | { kind: "err"; reason: "restaurant_closed" };

/**
 * Take a restaurant + line items and produce a fully-priced cart.
 * All prices in cents to match the domain types. Pure function — no
 * side effects, safe to call multiple times with the same inputs.
 */
export function priceCart(
  restaurantId: string,
  lines: PriceCartLineInput[],
): PriceCartOk | PriceCartErr {
  const restaurant = getRestaurantByIdMock(restaurantId);
  if (!restaurant) return { kind: "err", reason: "restaurant_not_found" };
  if (!restaurant.is_open) return { kind: "err", reason: "restaurant_closed" };

  let subtotal = 0;
  const cartLines: CartLine[] = [];
  for (const req of lines) {
    const item = findItemMock(restaurantId, req.item_id);
    if (!item) return { kind: "err", reason: "item_not_found", item_id: req.item_id };
    cartLines.push({
      item_id: item.id,
      name: item.name,
      quantity: req.quantity,
      unit_price_cents: item.price_cents,
      selected_modifiers: req.modifiers ?? {},
      notes: req.notes,
    });
    subtotal += item.price_cents * req.quantity;
  }

  const deliveryFee = 299; // $2.99 flat — mirrors PWA tool
  const serviceFee = Math.round(subtotal * 0.08);
  const taxBps = METROS[restaurant.metro]?.salesTaxBps ?? 825;
  const tax = Math.round((subtotal * taxBps) / 10_000);
  const total = subtotal + deliveryFee + serviceFee + tax;

  const cart: Cart = {
    restaurant_id: restaurantId,
    restaurant_name: restaurant.name,
    lines: cartLines,
    subtotal_cents: subtotal,
    delivery_fee_cents: deliveryFee,
    service_fee_cents: serviceFee,
    tax_cents: tax,
    total_cents: total,
    eta_minutes: restaurant.eta_minutes,
  };

  return { kind: "ok", cart };
}

/**
 * Canonical payload handed to attachSummary({ kind: "structured-cart" }).
 *
 * The SDK stable-stringifies this before sha256, so key order here does
 * NOT affect the hash — but keeping the shape minimal and intentional
 * does. We INCLUDE: restaurant_id, line identity + quantity + unit price,
 * money fields. We EXCLUDE: eta_minutes (shifts between calls as the
 * restaurant's kitchen load fluctuates — would cause spurious 409s),
 * restaurant_name (derived from restaurant_id), modifier labels (already
 * baked into unit_price_cents via the modifier surcharges we'll wire
 * later). This is the minimal thing the user is actually confirming:
 * "from *this* restaurant, *these* items at *these* prices, for *this*
 * total."
 */
export function canonicalCartSummary(cart: Cart): {
  restaurant_id: string;
  lines: Array<{
    item_id: string;
    quantity: number;
    unit_price_cents: number;
  }>;
  subtotal_cents: number;
  delivery_fee_cents: number;
  service_fee_cents: number;
  tax_cents: number;
  total_cents: number;
  currency: "USD";
} {
  return {
    restaurant_id: cart.restaurant_id,
    lines: cart.lines
      .map((l) => ({
        item_id: l.item_id,
        quantity: l.quantity,
        unit_price_cents: l.unit_price_cents,
      }))
      // Sort by item_id so the hash is insensitive to array order if
      // the orchestrator reshuffles the cart. stable-stringify sorts
      // object keys but preserves array order; we do the array sort.
      .sort((a, b) => (a.item_id < b.item_id ? -1 : a.item_id > b.item_id ? 1 : 0)),
    subtotal_cents: cart.subtotal_cents,
    delivery_fee_cents: cart.delivery_fee_cents,
    service_fee_cents: cart.service_fee_cents,
    tax_cents: cart.tax_cents,
    total_cents: cart.total_cents,
    currency: "USD",
  };
}
