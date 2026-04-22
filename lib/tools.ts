/**
 * Tool definitions exposed to the Claude agent.
 *
 * Each tool has:
 *   - a Zod parameter schema (for runtime validation and LLM SDK introspection)
 *   - an async execute() that returns the tool result to the model
 *
 * State persistence:
 *   Cart, order history, and the confirmation gate timestamp all go through
 *   the LumoStorage interface in ./storage.ts. That picks Postgres when
 *   DATABASE_URL is set (production on Vercel) and falls back to in-memory
 *   Maps when it isn't (local dev without env pull).
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
import { getStorage } from "./storage";
import { getPublishableKey, getStripe, hasStripe } from "./stripe";
import { METROS, type Cart, type Order } from "./types";
import { getSessionId } from "./session-context";

// Per-request sessionId — resolved from AsyncLocalStorage inside runWithSession,
// which /api/chat sets up on every POST. Falls back to "demo" when unset, so
// the web route (and ad-hoc tool invocations) keep working unchanged until we
// ship a matching web-side sessionId.
function sessionId(): string {
  return getSessionId();
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
          "korean",
          "vietnamese",
          "mediterranean",
          "breakfast",
          "dessert",
        ])
        .optional(),
      metro: z
        .enum(["austin", "los_angeles", "san_francisco", "chicago"])
        .optional()
        .describe(
          "Scope results to a single metro. Always pass this based on the user's saved address."
        ),
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
      "Add items to the user's cart. Call this once you've found the items the user wants. Replaces any existing cart from a different restaurant. IMPORTANT: this tool already returns a full cart card to the user and records the summary timestamp required by the place_order gate — do NOT also call get_cart_summary on the same turn.",
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
      // Sales tax derived from the restaurant's metro (TX 8.25, CA-LA 9.5,
      // CA-SF 8.625, IL-Chicago 10.25 — see METROS in lib/types.ts).
      const taxBps = METROS[restaurant.metro]?.salesTaxBps ?? 825;
      const tax = Math.round((subtotal * taxBps) / 10_000);
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

      const storage = getStorage();
      await storage.setCart(sessionId(), cart);
      await storage.setLastSummaryAt(sessionId(), Date.now());

      return { kind: "cart" as const, cart };
    },
  }),

  get_cart_summary: tool({
    description:
      "Show the current cart to the user. Always call this before asking the user to confirm an order — the confirmation gate requires a visible cart summary immediately before place_order.",
    parameters: z.object({}),
    execute: async () => {
      const storage = getStorage();
      const cart = await storage.getCart(sessionId());
      if (!cart) {
        return { kind: "empty_cart" as const };
      }
      await storage.setLastSummaryAt(sessionId(), Date.now());
      return { kind: "cart" as const, cart };
    },
  }),

  create_payment_intent: tool({
    description:
      "Create a Stripe PaymentIntent for the current cart so the user can enter card details. Call this AFTER showing the cart summary and AFTER the user signals they're ready to pay (e.g. 'ready to pay', 'let's checkout', 'place the order'). Returns a client_secret the frontend uses to collect payment. Do NOT call place_order until the frontend reports the payment has succeeded.",
    parameters: z.object({}),
    execute: async () => {
      const storage = getStorage();
      const cart = await storage.getCart(sessionId());
      if (!cart) {
        return { kind: "error" as const, message: "Cart is empty." };
      }

      // Demo / local path: no Stripe keys configured. Skip straight to the
      // cash-on-delivery flow — the agent can call place_order next turn.
      if (!hasStripe()) {
        return {
          kind: "payment_skipped" as const,
          reason: "stripe_not_configured",
          amount_cents: cart.total_cents,
        };
      }

      const stripe = getStripe();
      if (!stripe) {
        return {
          kind: "error" as const,
          message:
            "Payment backend misconfigured. Check STRIPE_SECRET_KEY.",
        };
      }

      // Reuse an existing PI if the amount hasn't changed — avoids creating
      // dead PIs every time the user edits the cart and comes back.
      const existing = await storage.getPaymentIntent(sessionId());
      if (
        existing &&
        existing.amount_cents === cart.total_cents &&
        existing.status !== "succeeded" &&
        existing.status !== "canceled"
      ) {
        return {
          kind: "payment_required" as const,
          payment_intent_id: existing.payment_intent_id,
          client_secret: existing.client_secret,
          amount_cents: existing.amount_cents,
          currency: "usd",
          publishable_key: getPublishableKey(),
        };
      }

      // Either nothing exists, the amount changed, or the PI is terminal.
      // Create a fresh one. If there's a stale non-terminal PI, cancel it
      // so we don't leave orphaned authorizations in Stripe.
      if (existing && existing.payment_intent_id !== "") {
        try {
          await stripe.paymentIntents.cancel(existing.payment_intent_id);
        } catch {
          // Non-fatal: PI may already be succeeded/canceled.
        }
      }

      try {
        const pi = await stripe.paymentIntents.create({
          amount: cart.total_cents,
          currency: "usd",
          // Automatic payment methods = cards + any wallets the account has on.
          automatic_payment_methods: { enabled: true },
          metadata: {
            session_id: sessionId(),
            restaurant_id: cart.restaurant_id,
            restaurant_name: cart.restaurant_name,
          },
          description: `Lumo order — ${cart.restaurant_name}`,
        });

        if (!pi.client_secret) {
          return {
            kind: "error" as const,
            message: "Stripe returned no client_secret.",
          };
        }

        await storage.setPaymentIntent(sessionId(), {
          payment_intent_id: pi.id,
          client_secret: pi.client_secret,
          amount_cents: cart.total_cents,
          status: pi.status,
        });

        return {
          kind: "payment_required" as const,
          payment_intent_id: pi.id,
          client_secret: pi.client_secret,
          amount_cents: cart.total_cents,
          currency: "usd",
          publishable_key: getPublishableKey(),
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown Stripe error";
        return { kind: "error" as const, message: `Payment setup failed: ${msg}` };
      }
    },
  }),

  place_order: tool({
    description:
      "Place the order with the merchant. ONLY call this after you have shown a cart summary AND the user has explicitly confirmed (yes/confirm/place it/go ahead). The user's most recent message MUST contain an explicit confirmation. When Stripe is configured, this will only succeed after the PaymentIntent has been paid by the client.",
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

      const storage = getStorage();

      // The summary must have been shown in the last ~60 seconds.
      const lastSummary = await storage.getLastSummaryAt(sessionId());
      if (!lastSummary || Date.now() - lastSummary > 60_000) {
        return {
          kind: "error" as const,
          message:
            "Order not placed: show the cart summary first by calling get_cart_summary.",
        };
      }

      const cart = await storage.getCart(sessionId());
      if (!cart) {
        return { kind: "error" as const, message: "Cart is empty." };
      }

      // Payment gate: when Stripe is configured, the PI must have succeeded
      // before we commit the order. We re-check with Stripe (not just our
      // cached status) because the client-side succeeded callback can lie.
      let paymentIntentId: string | undefined;
      if (hasStripe()) {
        const stripe = getStripe();
        const pi = await storage.getPaymentIntent(sessionId());
        if (!stripe || !pi) {
          return {
            kind: "error" as const,
            message:
              "Order not placed: no payment on file. Call create_payment_intent first and have the user complete payment.",
          };
        }

        let fresh;
        try {
          fresh = await stripe.paymentIntents.retrieve(pi.payment_intent_id);
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Stripe error";
          return {
            kind: "error" as const,
            message: `Payment lookup failed: ${msg}`,
          };
        }

        if (fresh.status !== "succeeded") {
          // Keep the cached status in sync for next attempt.
          await storage.setPaymentIntent(sessionId(), {
            payment_intent_id: fresh.id,
            client_secret: pi.client_secret,
            amount_cents: fresh.amount,
            status: fresh.status,
          });
          return {
            kind: "error" as const,
            message: `Order not placed: payment status is "${fresh.status}". Ask the user to complete payment.`,
          };
        }

        // Sanity check the charged amount matches the current cart.
        if (fresh.amount !== cart.total_cents) {
          return {
            kind: "error" as const,
            message:
              "Order not placed: paid amount differs from current cart total. Cart likely changed after payment — ask the user to re-confirm and retry.",
          };
        }

        paymentIntentId = fresh.id;
      }

      // Derive a plausible delivery address from the restaurant's metro so
      // the order confirmation card looks coherent across markets.
      const restaurantMetro = getRestaurantByIdMock(cart.restaurant_id)?.metro;
      const demoAddress = restaurantMetro
        ? `123 Main St, ${METROS[restaurantMetro].label} (demo)`
        : "123 Main St (demo)";

      const order: Order = {
        id: "ord_" + Math.random().toString(36).slice(2, 10),
        cart,
        address: demoAddress,
        placed_at: new Date().toISOString(),
        status: "placed",
        estimated_delivery_at: new Date(
          Date.now() + cart.eta_minutes * 60_000
        ).toISOString(),
        ...(paymentIntentId ? { payment_intent_id: paymentIntentId } : {}),
      };

      await storage.addOrder(sessionId(), order);

      // Clear cart + gate + PI after successful order.
      await storage.clearCart(sessionId());
      await storage.clearLastSummaryAt(sessionId());
      await storage.clearPaymentIntent(sessionId());

      return { kind: "order_placed" as const, order };
    },
  }),

  get_order_status: tool({
    description: "Look up the status of a placed order by ID.",
    parameters: z.object({
      order_id: z.string(),
    }),
    execute: async ({ order_id }) => {
      const storage = getStorage();
      const order = await storage.findOrder(sessionId(), order_id);
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
      const storage = getStorage();
      const orders = await storage.getOrderHistory(sessionId(), limit);
      return { kind: "order_history" as const, orders };
    },
  }),
};

export type LumoTools = typeof tools;
