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

// ----- Cart-add evidence gate -----------------------------------------------
// Words that describe a cuisine / vague craving, not a specific item. If the
// model quotes any of these as user_selection_evidence for a specific item,
// we reject — the user has to actually pick something. This list is narrow on
// purpose: it only catches the single-word generic case. Real item names like
// "pepperoni pizza", "margherita", "thai green curry" pass through because
// they're multi-word OR name a specific dish.
const GENERIC_PHRASES = new Set<string>([
  "food", "anything", "something", "whatever", "surprise", "surprise me",
  "hungry", "order", "order something", "order me something", "dinner",
  "lunch", "breakfast", "brunch", "a meal", "meal", "the usual", "usual",
  "pizza", "pasta", "burger", "burgers", "sushi", "curry", "tacos",
  "thai", "indian", "chinese", "mexican", "italian", "japanese", "korean",
  "vietnamese", "mediterranean", "american", "dessert", "drinks", "a drink",
  "coffee", "tea", "yes", "go", "ok", "sure", "sounds good", "confirm",
]);

// ----- Confirmation-phrase gate (place_order) ------------------------------
// The model is required to quote a confirmation word from the user's latest
// message. We enforce two things in code: (1) the quote is in an allowlist of
// confirmation words, (2) the quote actually appears in the user's latest
// message (no fabrication). "sure" / "ok" / "sounds good" are deliberately
// EXCLUDED — the system prompt tells the model those are too ambiguous and
// must trigger a re-ask. If the model ever passes one, we reject hard.
const CONFIRMATION_PHRASES = new Set<string>([
  "yes", "yep", "yeah", "yup",
  "confirm", "confirmed",
  "place it", "place order", "place the order",
  "go ahead", "go for it", "do it", "let's do it", "lets do it",
  "order it", "order now",
  "send it", "ship it",
  // Post-payment signals — frontend or user may report these after PaymentSheet
  // / Elements succeed. Valid confirmations in the cash-on-delivery path too.
  "paid", "payment done", "payment confirmed", "payment complete",
  "payment success", "payment succeeded",
]);

/**
 * True when the entire user message is a vague cuisine / mood ping. In that
 * case we refuse to build a cart no matter what the model claims as evidence:
 * there is no valid per-item selection in a 1-3 word craving ("pizza" /
 * "I'm hungry" / "thai food tonight"). Show the menu and ask.
 */
function isVagueUserIntent(intentLower: string): boolean {
  // Strip punctuation and collapse whitespace so "pizza!" matches "pizza".
  const cleaned = intentLower.replace(/[^a-z0-9' ]/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return true;
  if (GENERIC_PHRASES.has(cleaned)) return true;
  // 1–3 words AND every token is in the generic list → vague.
  const tokens = cleaned.split(" ").filter(Boolean);
  if (tokens.length > 0 && tokens.length <= 3) {
    const everyTokenGeneric = tokens.every(
      (t) =>
        GENERIC_PHRASES.has(t) ||
        t === "i" || t === "i'm" || t === "im" || t === "am" ||
        t === "for" || t === "please" || t === "want" || t === "tonight" ||
        t === "now" || t === "today"
    );
    if (everyTokenGeneric) return true;
  }
  return false;
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
      "Add items to the user's cart. Call this ONLY when the user has explicitly selected the items — either by naming a specific item in their message, or by tapping a menu checkbox (which arrives as 'Add <item> from <restaurant>'). Do NOT call this on vague prompts like 'pizza', 'I'm hungry', 'order me something'; in those cases show the menu and ask first. Every item must carry user_selection_evidence — the exact phrase from the user's message that selects that specific item. A cuisine word is NOT valid evidence for a specific item. Replaces any existing cart from a different restaurant. This tool already returns a full cart card AND records the summary timestamp required by the place_order gate — do NOT also call get_cart_summary on the same turn.",
    parameters: z.object({
      restaurant_id: z.string(),
      user_intent_message: z
        .string()
        .min(1)
        .describe(
          "Quote the user's most recent message verbatim. This is the message that justifies calling build_cart. Stored for audit."
        ),
      items: z
        .array(
          z.object({
            item_id: z.string(),
            quantity: z.number().int().positive().default(1),
            modifiers: z.record(z.string()).optional(),
            notes: z.string().optional(),
            user_selection_evidence: z
              .string()
              .min(2)
              .describe(
                "Exact phrase from the user's most recent message that selects THIS specific item. E.g. 'large pepperoni', 'margherita', 'a side of garlic knots'. A bare cuisine word like 'pizza' is NOT valid — show the menu and ask instead."
              ),
          })
        )
        .min(1),
    }),
    execute: async ({ restaurant_id, items, user_intent_message }) => {
      const storage = getStorage();
      const sid = sessionId();

      // -- Evidence gate --------------------------------------------------
      // Reject in code before mutating state. This is the belt to the prompt's
      // suspenders — LLMs skip instructions, so we verify here.
      const intentLower = (user_intent_message ?? "").trim().toLowerCase();
      if (!intentLower) {
        await storage.recordCartAudit({
          session_id: sid,
          outcome: "rejected",
          restaurant_id,
          item_count: items.length,
          user_intent_message: user_intent_message ?? "",
          evidence: items.map((i) => ({
            item_id: i.item_id,
            phrase: i.user_selection_evidence ?? "",
          })),
          reject_reason: "missing_user_intent_message",
        });
        return {
          kind: "error" as const,
          message:
            "Cart not updated: missing user_intent_message. Do not call build_cart unless the user has selected items in their latest message. Show the menu and ask them to pick.",
        };
      }

      // If the user's entire message is a generic cuisine / vague intent,
      // we refuse regardless of what the model claimed as evidence.
      if (isVagueUserIntent(intentLower)) {
        await storage.recordCartAudit({
          session_id: sid,
          outcome: "rejected",
          restaurant_id,
          item_count: items.length,
          user_intent_message,
          evidence: items.map((i) => ({
            item_id: i.item_id,
            phrase: i.user_selection_evidence,
          })),
          reject_reason: `vague_user_intent:${intentLower.slice(0, 40)}`,
        });
        return {
          kind: "error" as const,
          message:
            "Cart not updated: the user's message is too vague to justify adding specific items. Call get_restaurant_menu and let the user pick items by name or checkbox.",
        };
      }

      // Per-item evidence check. Each phrase must (1) not be a generic
      // cuisine word, and (2) appear in the user's message (case-insensitive
      // substring match — the model must be quoting the user, not inventing).
      for (const req of items) {
        const phrase = (req.user_selection_evidence ?? "").trim().toLowerCase();
        if (!phrase || phrase.length < 2) {
          await storage.recordCartAudit({
            session_id: sid,
            outcome: "rejected",
            restaurant_id,
            item_count: items.length,
            user_intent_message,
            evidence: items.map((i) => ({
              item_id: i.item_id,
              phrase: i.user_selection_evidence,
            })),
            reject_reason: `empty_evidence:${req.item_id}`,
          });
          return {
            kind: "error" as const,
            message: `Cart not updated: missing user_selection_evidence for item ${req.item_id}. Ask the user to name the item they want.`,
          };
        }
        if (GENERIC_PHRASES.has(phrase)) {
          await storage.recordCartAudit({
            session_id: sid,
            outcome: "rejected",
            restaurant_id,
            item_count: items.length,
            user_intent_message,
            evidence: items.map((i) => ({
              item_id: i.item_id,
              phrase: i.user_selection_evidence,
            })),
            reject_reason: `generic_evidence:${phrase}`,
          });
          return {
            kind: "error" as const,
            message: `Cart not updated: "${phrase}" is a cuisine or generic word, not an item-level selection. Show the menu and ask the user to pick a specific item.`,
          };
        }
        if (!intentLower.includes(phrase)) {
          await storage.recordCartAudit({
            session_id: sid,
            outcome: "rejected",
            restaurant_id,
            item_count: items.length,
            user_intent_message,
            evidence: items.map((i) => ({
              item_id: i.item_id,
              phrase: i.user_selection_evidence,
            })),
            reject_reason: `fabricated_evidence:${phrase}`,
          });
          return {
            kind: "error" as const,
            message: `Cart not updated: user_selection_evidence "${phrase}" is not present in the user's latest message. Do not fabricate quotes. Ask the user to confirm the item by name.`,
          };
        }
      }

      // -- End evidence gate ----------------------------------------------

      // -- Cart-lock while payment is in flight ---------------------------
      // If a PaymentIntent has already succeeded (user paid) or is mid-capture,
      // we must NOT mutate the cart — otherwise the paid amount diverges from
      // the cart total and place_order will either reject or silently commit
      // the wrong total. Force the model to restart the checkout flow.
      const activePi = await storage.getPaymentIntent(sid);
      if (
        activePi &&
        (activePi.status === "succeeded" || activePi.status === "requires_capture")
      ) {
        await storage.recordCartAudit({
          session_id: sid,
          outcome: "rejected",
          restaurant_id,
          item_count: items.length,
          user_intent_message,
          evidence: items.map((i) => ({
            item_id: i.item_id,
            phrase: i.user_selection_evidence,
          })),
          reject_reason: `cart_locked_payment_${activePi.status}`,
        });
        return {
          kind: "error" as const,
          message:
            "Cart is locked: the user has already paid for the current cart. Do not add items. If they want to change the order, place the paid order first with place_order, then they can start a new cart afterward.",
        };
      }
      // -- End cart-lock --------------------------------------------------

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

      await storage.setCart(sid, cart);
      await storage.setLastSummaryAt(sid, Date.now());
      await storage.recordCartAudit({
        session_id: sid,
        outcome: "accepted",
        restaurant_id,
        item_count: items.length,
        user_intent_message,
        evidence: items.map((i) => ({
          item_id: i.item_id,
          phrase: i.user_selection_evidence,
        })),
      });

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
      const sid = sessionId();
      const cart = await storage.getCart(sid);
      if (!cart) {
        await storage.recordPaymentAudit({
          session_id: sid,
          stage: "create_payment_intent",
          outcome: "pi_error_no_cart",
          reason: "cart empty at create_payment_intent",
        });
        return { kind: "error" as const, message: "Cart is empty." };
      }

      // Demo / local path: no Stripe keys configured. Skip straight to the
      // cash-on-delivery flow — the agent can call place_order next turn.
      if (!hasStripe()) {
        await storage.recordPaymentAudit({
          session_id: sid,
          stage: "create_payment_intent",
          outcome: "pi_skipped_demo",
          amount_cents: cart.total_cents,
          reason: "stripe_not_configured",
        });
        return {
          kind: "payment_skipped" as const,
          reason: "stripe_not_configured",
          amount_cents: cart.total_cents,
        };
      }

      const stripe = getStripe();
      if (!stripe) {
        await storage.recordPaymentAudit({
          session_id: sid,
          stage: "create_payment_intent",
          outcome: "pi_error_no_secret",
          amount_cents: cart.total_cents,
          reason: "STRIPE_SECRET_KEY missing",
        });
        return {
          kind: "error" as const,
          message:
            "Payment backend misconfigured. Check STRIPE_SECRET_KEY.",
        };
      }

      // Reuse an existing PI if the amount hasn't changed — avoids creating
      // dead PIs every time the user edits the cart and comes back.
      const existing = await storage.getPaymentIntent(sid);
      if (
        existing &&
        existing.amount_cents === cart.total_cents &&
        existing.status !== "succeeded" &&
        existing.status !== "canceled"
      ) {
        await storage.recordPaymentAudit({
          session_id: sid,
          stage: "create_payment_intent",
          outcome: "pi_reused",
          payment_intent_id: existing.payment_intent_id,
          amount_cents: existing.amount_cents,
          reason: `status:${existing.status}`,
        });
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
          await storage.recordPaymentAudit({
            session_id: sid,
            stage: "create_payment_intent",
            outcome: "pi_canceled_stale",
            payment_intent_id: existing.payment_intent_id,
            amount_cents: existing.amount_cents,
            reason: `superseded:amount_changed_or_terminal`,
          });
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
            session_id: sid,
            restaurant_id: cart.restaurant_id,
            restaurant_name: cart.restaurant_name,
          },
          description: `Lumo order — ${cart.restaurant_name}`,
        });

        if (!pi.client_secret) {
          await storage.recordPaymentAudit({
            session_id: sid,
            stage: "create_payment_intent",
            outcome: "pi_error_stripe",
            payment_intent_id: pi.id,
            amount_cents: cart.total_cents,
            reason: "no client_secret on PI",
          });
          return {
            kind: "error" as const,
            message: "Stripe returned no client_secret.",
          };
        }

        await storage.setPaymentIntent(sid, {
          payment_intent_id: pi.id,
          client_secret: pi.client_secret,
          amount_cents: cart.total_cents,
          status: pi.status,
        });
        await storage.recordPaymentAudit({
          session_id: sid,
          stage: "create_payment_intent",
          outcome: "pi_created",
          payment_intent_id: pi.id,
          amount_cents: cart.total_cents,
          reason: `status:${pi.status}`,
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
        await storage.recordPaymentAudit({
          session_id: sid,
          stage: "create_payment_intent",
          outcome: "pi_error_stripe",
          amount_cents: cart.total_cents,
          reason: msg,
        });
        return { kind: "error" as const, message: `Payment setup failed: ${msg}` };
      }
    },
  }),

  place_order: tool({
    description:
      "Place the order with the merchant. ONLY call this after you have shown a cart summary AND the user has explicitly confirmed (yes/confirm/place it/go ahead/paid). The user's most recent message MUST contain an explicit confirmation. You must pass user_intent_message (the user's verbatim latest message) and confirmation_phrase (a confirmation word quoted directly from it). When Stripe is configured, this will only succeed after the PaymentIntent has been paid by the client.",
    parameters: z.object({
      user_confirmed: z
        .boolean()
        .describe(
          "Must be true, and only set to true when the user's latest message contains an explicit confirmation keyword."
        ),
      confirmation_phrase: z
        .string()
        .min(2)
        .describe(
          "Quote the exact confirmation word or phrase from the user's most recent message — e.g. 'confirm', 'yes', 'paid', 'place it'. Must appear verbatim in user_intent_message."
        ),
      user_intent_message: z
        .string()
        .min(1)
        .describe(
          "Quote the user's most recent message verbatim. Stored for audit and used to verify confirmation_phrase isn't fabricated."
        ),
    }),
    execute: async ({
      user_confirmed,
      confirmation_phrase,
      user_intent_message,
    }) => {
      const storage = getStorage();
      const sid = sessionId();

      // Defense-in-depth: enforce confirmation in code.
      if (!user_confirmed || !confirmation_phrase) {
        await storage.recordPaymentAudit({
          session_id: sid,
          stage: "place_order",
          outcome: "order_rejected_no_confirmation",
          reason: !user_confirmed
            ? "user_confirmed=false"
            : "confirmation_phrase empty",
        });
        return {
          kind: "error" as const,
          message:
            "Order not placed: confirmation required. Ask the user 'Ready to place this? Reply confirm to order.'",
        };
      }

      // Confirmation-phrase gate (L2) — same fabrication-check pattern as the
      // cart-add evidence gate. The model must (1) pick a phrase from a
      // known allowlist, and (2) the phrase must appear verbatim in the
      // user's latest message. Without these two checks, the model can
      // invent a confirmation the user never gave.
      const phraseLower = confirmation_phrase.trim().toLowerCase();
      const intentLower = (user_intent_message ?? "").trim().toLowerCase();

      if (!CONFIRMATION_PHRASES.has(phraseLower)) {
        await storage.recordPaymentAudit({
          session_id: sid,
          stage: "place_order",
          outcome: "order_rejected_unknown_phrase",
          reason: `phrase:${phraseLower.slice(0, 80)}`,
        });
        return {
          kind: "error" as const,
          message: `Order not placed: "${confirmation_phrase}" is not a clear confirmation. Ask the user to reply 'confirm' or 'yes' to place the order.`,
        };
      }

      if (!intentLower || !intentLower.includes(phraseLower)) {
        await storage.recordPaymentAudit({
          session_id: sid,
          stage: "place_order",
          outcome: "order_rejected_fabricated_phrase",
          reason: `phrase:${phraseLower.slice(0, 40)} not in message:${intentLower.slice(0, 80)}`,
        });
        return {
          kind: "error" as const,
          message: `Order not placed: confirmation_phrase "${confirmation_phrase}" is not present in the user's latest message. Do not fabricate confirmations. Ask the user to explicitly confirm.`,
        };
      }

      // The summary must have been shown in the last ~60 seconds.
      const lastSummary = await storage.getLastSummaryAt(sid);
      if (!lastSummary || Date.now() - lastSummary > 60_000) {
        await storage.recordPaymentAudit({
          session_id: sid,
          stage: "place_order",
          outcome: "order_rejected_no_summary",
          reason: lastSummary
            ? `summary_stale_by_ms:${Date.now() - lastSummary}`
            : "no_summary",
        });
        return {
          kind: "error" as const,
          message:
            "Order not placed: show the cart summary first by calling get_cart_summary.",
        };
      }

      const cart = await storage.getCart(sid);
      if (!cart) {
        await storage.recordPaymentAudit({
          session_id: sid,
          stage: "place_order",
          outcome: "order_rejected_empty_cart",
          reason: "no_cart_at_place_order",
        });
        return { kind: "error" as const, message: "Cart is empty." };
      }

      // Payment gate: when Stripe is configured, the PI must have succeeded
      // before we commit the order. We re-check with Stripe (not just our
      // cached status) because the client-side succeeded callback can lie.
      let paymentIntentId: string | undefined;
      if (hasStripe()) {
        const stripe = getStripe();
        const pi = await storage.getPaymentIntent(sid);
        if (!stripe || !pi) {
          await storage.recordPaymentAudit({
            session_id: sid,
            stage: "place_order",
            outcome: "order_rejected_no_pi",
            amount_cents: cart.total_cents,
            reason: stripe ? "no_pi_row" : "no_stripe_client",
          });
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
          await storage.recordPaymentAudit({
            session_id: sid,
            stage: "place_order",
            outcome: "order_rejected_pi_status",
            payment_intent_id: pi.payment_intent_id,
            amount_cents: cart.total_cents,
            reason: `retrieve_failed:${msg}`,
          });
          return {
            kind: "error" as const,
            message: `Payment lookup failed: ${msg}`,
          };
        }

        if (fresh.status !== "succeeded") {
          // Keep the cached status in sync for next attempt.
          await storage.setPaymentIntent(sid, {
            payment_intent_id: fresh.id,
            client_secret: pi.client_secret,
            amount_cents: fresh.amount,
            status: fresh.status,
          });
          await storage.recordPaymentAudit({
            session_id: sid,
            stage: "place_order",
            outcome: "order_rejected_pi_status",
            payment_intent_id: fresh.id,
            amount_cents: fresh.amount,
            reason: `status:${fresh.status}`,
          });
          return {
            kind: "error" as const,
            message: `Order not placed: payment status is "${fresh.status}". Ask the user to complete payment.`,
          };
        }

        // Sanity check the charged amount matches the current cart. If it
        // doesn't, we're in the danger zone — user paid $X, cart now costs
        // $Y. The build_cart cart-lock should prevent this, but if it ever
        // fires (e.g. cart mutated via another path), auto-refund so the
        // user isn't out money. Refund is best-effort; if it fails we
        // surface clearly so ops can intervene.
        if (fresh.amount !== cart.total_cents) {
          try {
            await stripe.refunds.create({ payment_intent: fresh.id });
            await storage.clearPaymentIntent(sid);
            await storage.recordPaymentAudit({
              session_id: sid,
              stage: "place_order",
              outcome: "order_refunded_amount_mismatch",
              payment_intent_id: fresh.id,
              amount_cents: fresh.amount,
              reason: `refunded_${fresh.amount}_cart_${cart.total_cents}`,
            });
            return {
              kind: "error" as const,
              message: `Order not placed: you paid $${(fresh.amount / 100).toFixed(2)} but the cart total is now $${(cart.total_cents / 100).toFixed(2)}. We've refunded the original payment — please start a new checkout.`,
            };
          } catch (err) {
            const msg = err instanceof Error ? err.message : "Refund error";
            await storage.recordPaymentAudit({
              session_id: sid,
              stage: "place_order",
              outcome: "order_refund_failed",
              payment_intent_id: fresh.id,
              amount_cents: fresh.amount,
              reason: `refund_failed:${msg}_cart_${cart.total_cents}`,
            });
            return {
              kind: "error" as const,
              message: `Order not placed: paid amount ($${(fresh.amount / 100).toFixed(2)}) differs from cart total ($${(cart.total_cents / 100).toFixed(2)}) and the automatic refund failed (${msg}). Support has been notified — do not retry.`,
            };
          }
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

      await storage.addOrder(sid, order);

      // Clear cart + gate + PI after successful order.
      await storage.clearCart(sid);
      await storage.clearLastSummaryAt(sid);
      await storage.clearPaymentIntent(sid);

      await storage.recordPaymentAudit({
        session_id: sid,
        stage: "place_order",
        outcome: "order_placed",
        payment_intent_id: paymentIntentId ?? null,
        amount_cents: cart.total_cents,
        reason: `order_id:${order.id}`,
      });

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
