/**
 * Tool definitions exposed to the Claude agent.
 *
 * Each tool has:
 *   - a Zod parameter schema (for runtime validation and LLM SDK introspection)
 *   - an async execute() that returns the tool result to the model
 *
 * The confirmation gate for place_order is enforced HERE, not just in the
 * system prompt, because LLMs occasionally skip instructions. Defense in depth.
 */

import { tool } from "ai";
import { z } from "zod";
import {
  searchRestaurantsMock,
  getRestaurantByIdMock,
  getMenuMock,
  findItemMock,
} from "./mock-data";
import type { Cart, Order } from "./types";

// ----- In-memory session state (per-request, demo-grade) --------------------
// For the real product this lives in Redis or Postgres keyed by user session.
// For the MVP demo, keeping it in a module-level Map is fine.
const sessionCarts = new Map<string, Cart>();
const sessionOrders = new Map<string, Order[]>();
const sessionLastSummary = new Map<string, number>(); // track last cart summary ts

function sessionId() {
  // In the MVP, every request from the frontend sends a sessionId cookie/header.
  // For now we pin everything to "demo".
  return "demo";
}

// ----- Tools ----------------------------------------------------------------

export const tools = {
  search_restaurants: tool({
    description:
      "Search available restaurants near the user's saved address. Use this the moment the user expresses food intent. Filter by cuisine, sort by rating, distance, or ETA.",
    parameters: z.object({
      query: z
        .string()
        .optional()
        .describe(
          "Free-text search term: restaurant name, cuisine, or dish. Leave empty to browse."
        ),
      cuisine: z
        .enum([
          "pizza",
          "mexican",
          "indian",
          "thai",
          "chinese",
          "american",
          "japanese",
          "mediterranean",
          "breakfast",
          "dessert",
        ])
        .optional(),
      sort: z
        .enum(["rating", "distance", "eta", "price_low"])
        .optional()
        .default("rating"),
      max_eta_minutes: z.number().int().positive().optional(),
      limit: z.number().int().positive().max(10).optional().default(5),
    }),
    execute: async (args) => {
      const results = searchRestaurantsMock(args);
      return {
        kind: "restaurants" as const,
        count: results.length,
        restaurants: results,
      };
    },
  }),

  get_restaurant_menu: tool({
    description:
      "Fetch the full menu for a specific restaurant by ID. Call this after the user picks a restaurant, so you can locate the exact items they want.",
    parameters: z.object({
      restaurant_id: z.string(),
    }),
    execute: async ({ restaurant_id }) => {
      const restaurant = getRestaurantByIdMock(restaurant_id);
      if (!restaurant) {
        return { kind: "error" as const, message: "Restaurant not found." };
      }
      const menu = getMenuMock(restaurant_id);
      return {
        kind: "menu" as const,
        restaurant_id,
        restaurant_name: restaurant.name,
        items: menu,
      };
    },
  }),

  build_cart: tool({
    description:
      "Add items to the user's cart. Call this once you've found the items the user wants. Replaces any existing cart from a different restaurant.",
    parameters: z.object({
      restaurant_id: z.string(),
      items: z
        .array(
          z.object({
            item_id: z.string(),
            quantity: z.number().int().positive().default(1),
            modifiers: z.record(z.string()).optional(),
            notes: z.string().optional(),
          })
        )
        .min(1),
    }),
    execute: async ({ restaurant_id, items }) => {
      const restaurant = getRestaurantByIdMock(restaurant_id);
      if (!restaurant) {
        return { kind: "error" as const, message: "Restaurant not found." };
      }

      let subtotal = 0;
      const lines = items.map((req) => {
        const item = findItemMock(restaurant_id, req.item_id);
        if (!item) throw new Error(`Item ${req.item_id} not found`);
        const line = {
          item_id: item.id,
          name: item.name,
          quantity: req.quantity,
          unit_price_cents: item.price_cents,
          selected_modifiers: req.modifiers ?? {},
          notes: req.notes,
        };
        subtotal += item.price_cents * req.quantity;
        return line;
      });

      const deliveryFee = 299; // $2.99 — flat for MVP
      const serviceFee = Math.round(subtotal * 0.08); // 8% service fee
      const tax = Math.round(subtotal * 0.0825); // Austin sales tax ~8.25%
      const total = subtotal + deliveryFee + serviceFee + tax;

      const cart: Cart = {
        restaurant_id,
        restaurant_name: restaurant.name,
        lines,
        subtotal_cents: subtotal,
        delivery_fee_cents: deliveryFee,
        service_fee_cents: serviceFee,
        tax_cents: tax,
        total_cents: total,
        eta_minutes: restaurant.eta_minutes,
      };

      sessionCarts.set(sessionId(), cart);
      sessionLastSummary.set(sessionId(), Date.now());

      return { kind: "cart" as const, cart };
    },
  }),

  get_cart_summary: tool({
    description:
      "Show the current cart to the user. Always call this before asking the user to confirm an order — the confirmation gate requires a visible cart summary immediately before place_order.",
    parameters: z.object({}),
    execute: async () => {
      const cart = sessionCarts.get(sessionId());
      if (!cart) {
        return { kind: "empty_cart" as const };
      }
      sessionLastSummary.set(sessionId(), Date.now());
      return { kind: "cart" as const, cart };
    },
  }),

  place_order: tool({
    description:
      "Place the order with the merchant. ONLY call this after you have shown a cart summary AND the user has explicitly confirmed (yes/confirm/place it/go ahead). The user's most recent message MUST contain an explicit confirmation.",
    parameters: z.object({
      user_confirmed: z
        .boolean()
        .describe(
          "Must be true, and only set to true when the user's latest message contains an explicit confirmation keyword."
        ),
      confirmation_phrase: z
        .string()
        .describe(
          "Quote the exact confirmation word or phrase from the user's most recent message."
        ),
    }),
    execute: async ({ user_confirmed, confirmation_phrase }) => {
      // Defense-in-depth: enforce confirmation in code.
      if (!user_confirmed || !confirmation_phrase) {
        return {
          kind: "error" as const,
          message:
            "Order not placed: confirmation required. Ask the user 'Ready to place this? Reply confirm to order.'",
        };
      }

      // The summary must have been shown in the last ~60 seconds.
      const lastSummary = sessionLastSummary.get(sessionId());
      if (!lastSummary || Date.now() - lastSummary > 60_000) {
        return {
          kind: "error" as const,
          message:
            "Order not placed: show the cart summary first by calling get_cart_summary.",
        };
      }

      const cart = sessionCarts.get(sessionId());
      if (!cart) {
        return { kind: "error" as const, message: "Cart is empty." };
      }

      const order: Order = {
        id: "ord_" + Math.random().toString(36).slice(2, 10),
        cart,
        address: "123 Main St, Austin, TX (demo)",
        placed_at: new Date().toISOString(),
        status: "placed",
        estimated_delivery_at: new Date(
          Date.now() + cart.eta_minutes * 60_000
        ).toISOString(),
      };

      const history = sessionOrders.get(sessionId()) ?? [];
      history.unshift(order);
      sessionOrders.set(sessionId(), history);

      // Clear cart after successful order.
      sessionCarts.delete(sessionId());
      sessionLastSummary.delete(sessionId());

      return { kind: "order_placed" as const, order };
    },
  }),

  get_order_status: tool({
    description: "Look up the status of a placed order by ID.",
    parameters: z.object({
      order_id: z.string(),
    }),
    execute: async ({ order_id }) => {
      const history = sessionOrders.get(sessionId()) ?? [];
      const order = history.find((o) => o.id === order_id);
      if (!order) {
        return { kind: "error" as const, message: "Order not found." };
      }
      return { kind: "order_status" as const, order };
    },
  }),

  get_order_history: tool({
    description:
      "Fetch the user's recent orders. Useful when they say 'order my usual' or 'reorder last night's'.",
    parameters: z.object({
      limit: z.number().int().positive().max(10).optional().default(3),
    }),
    execute: async ({ limit }) => {
      const history = (sessionOrders.get(sessionId()) ?? []).slice(0, limit);
      return { kind: "order_history" as const, orders: history };
    },
  }),
};

export type LumoTools = typeof tools;
