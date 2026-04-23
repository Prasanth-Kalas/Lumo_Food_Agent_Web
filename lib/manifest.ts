/**
 * Food Agent manifest factory.
 *
 * The manifest is the single source of truth the Super Agent shell reads
 * at registry boot (via `/.well-known/agent.json`). It describes *what*
 * this agent does — not *how* — and declares the PII scope and SLA the
 * router will enforce.
 *
 * URLs must be absolute (AgentManifestSchema enforces z.string().url()).
 * Base URL resolution lives in lib/public-base-url.ts so we share the
 * same fallback chain with app/openapi.json/route.ts.
 */

import { defineManifest, type AgentManifest } from "@lumo/agent-sdk";
import { publicBaseUrl } from "./public-base-url";

/**
 * Build the manifest at request time so `PUBLIC_BASE_URL` can be changed
 * without rebuilding (Vercel preview URLs, staging overlays, etc.).
 */
export function buildManifest(): AgentManifest {
  const base = publicBaseUrl();

  return defineManifest({
    agent_id: "food",
    version: "0.1.0",
    domain: "food",
    display_name: "Lumo Food",
    one_liner: "Search restaurants, price a cart, and place delivery orders.",

    // Canonical intents the orchestrator maps utterances to. Keep these
    // stable — analytics joins on them. "search_restaurants" covers both
    // the "find me tacos" and "what's near me" phrasings; "place_food_order"
    // is the money-moving intent; "cancel_food_order" is the compensation.
    intents: [
      "search_restaurants",
      "get_restaurant_menu",
      "price_food_cart",
      "place_food_order",
      "cancel_food_order",
    ],

    example_utterances: [
      "order a pepperoni pizza and a Caesar salad from the closest place",
      "get me tacos from the best spot in Austin",
      "I want dim sum delivered, cheapest option",
      "reorder my usual from Homeslice",
    ],

    openapi_url: `${base}/openapi.json`,
    // No MCP surface yet — agent speaks OpenAPI only.

    ui: {
      // Registered component names the shell is allowed to render into
      // its canvas. These must exist in the web shell's component
      // registry (see Lumo_Super_Agent/components).
      components: ["food_cart_card", "food_order_summary"],
    },

    health_url: `${base}/api/health`,

    // SLA budgets. The shell's circuit breaker uses p95_latency_ms as
    // the "latency overshoot" denominator; availability_target feeds the
    // rolling score. Numbers below are aspirational for the mock-data
    // phase — tune once we wire a real food provider (MealMe/Olo).
    sla: {
      p50_latency_ms: 800,
      p95_latency_ms: 2500,
      availability_target: 0.995,
    },

    // PII scope — the absolute max this agent may *ever* see. The router
    // intersects this with the per-tool `x-lumo-pii-required` so each
    // tool only gets what it strictly needs. No passport here — food
    // delivery is domestic only. `address` is the SDK's canonical
    // delivery-address field; the semantic narrowing (street address
    // for drop-off) is documented at the tool level.
    pii_scope: [
      "name",
      "email",
      "phone",
      "payment_method_id",
      "address",
    ],

    requires_payment: true,

    // US-only for the MVP. Four metros are currently seeded in mock-data.
    supported_regions: ["US"],

    // Contract self-declaration. Bump `sdk_version` when we rebuild
    // against a newer SDK. `implements_cancellation` is true from v0 —
    // the SDK's openapi bridge enforces the bidirectional link
    // (`food_place_order` ↔ `food_cancel_order`) at registry load.
    capabilities: {
      sdk_version: "0.2.0-rc.2",
      supports_compound_bookings: true,
      implements_cancellation: true,
    },

    owner_team: "agents-platform",
  });
}
