/**
 * GET /openapi.json
 *
 * OpenAPI 3.1 document for the Food Agent. Four operations exposed
 * as orchestrator tools via `x-lumo-tool: true`:
 *
 *   1. food_search_restaurants — read, free, no PII
 *   2. food_price_cart         — read, low, no PII; returns a priced
 *                                cart + `_lumo_summary` the shell can
 *                                show the user before confirmation
 *   3. food_place_order        — money tool. Requires confirmation
 *                                gate (`structured-cart`) + PII
 *                                payload. Pairs with food_cancel_order.
 *   4. food_cancel_order       — compensating action. `x-lumo-cancel-for
 *                                food_place_order`. Free, no confirmation
 *                                (Saga invokes with no human in the loop).
 *
 * The `x-lumo-*` extensions drive the orchestrator's tool registry
 * and the router's gating table. See @lumo/agent-sdk/openapi for the
 * full extension contract — notably `validateCancellationProtocol`
 * refuses to boot the registry if the bidirectional cancel link
 * (x-lumo-cancels ↔ x-lumo-cancel-for) is missing or one-sided.
 */

import { NextResponse } from "next/server";

import { publicBaseUrl } from "@/lib/public-base-url";

export const dynamic = "force-dynamic";

export async function GET() {
  const base = publicBaseUrl();

  const doc = {
    openapi: "3.1.0",
    info: {
      title: "Lumo Food Agent",
      version: "0.1.0",
      description:
        "Restaurant search, cart pricing, order placement and cancellation. Service endpoint consumed by the Lumo orchestrator shell.",
    },
    servers: [{ url: base }],

    // ────────────────────────────────────────────────────────────────
    // Paths
    // ────────────────────────────────────────────────────────────────
    paths: {
      "/api/tools/food_search_restaurants": {
        post: {
          operationId: "food_search_restaurants",
          summary: "Search restaurants in a metro",
          description:
            "Return up to N restaurants matching a cuisine / query / sort in one of Lumo's four serviced metros. No PII required. Results are NOT price-guaranteed — call food_price_cart before placing an order.",

          "x-lumo-tool": true,
          "x-lumo-cost-tier": "free",
          "x-lumo-requires-confirmation": false,
          "x-lumo-pii-required": [],
          "x-lumo-intent-tags": ["search_restaurants"],

          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/FoodSearchRequest" },
              },
            },
          },
          responses: {
            "200": {
              description: "Restaurants found",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/FoodSearchResponse" },
                },
              },
            },
            "400": { $ref: "#/components/responses/BadRequest" },
            "429": { $ref: "#/components/responses/RateLimited" },
          },
        },
      },

      "/api/tools/food_get_restaurant_menu": {
        post: {
          operationId: "food_get_restaurant_menu",
          summary: "Fetch a restaurant's menu",
          description:
            "Return the full menu for one restaurant discovered via food_search_restaurants. Items are normalized to the shape food_price_cart consumes (`item_id`, `unit_price_cents`), so the orchestrator can forward a selection straight into a cart. No PII required.",

          "x-lumo-tool": true,
          "x-lumo-cost-tier": "free",
          "x-lumo-requires-confirmation": false,
          "x-lumo-pii-required": [],
          "x-lumo-intent-tags": ["get_restaurant_menu"],

          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/FoodGetRestaurantMenuRequest" },
              },
            },
          },
          responses: {
            "200": {
              description: "Restaurant menu",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/FoodGetRestaurantMenuResponse" },
                },
              },
            },
            "400": { $ref: "#/components/responses/BadRequest" },
            "404": { $ref: "#/components/responses/RestaurantOrItemNotFound" },
          },
        },
      },

      "/api/tools/food_price_cart": {
        post: {
          operationId: "food_price_cart",
          summary: "Price a cart (restaurant + line items)",
          description:
            "Given a restaurant_id and a list of items, return a fully-priced cart (subtotal, delivery, service, tax, total) plus a `_lumo_summary` containing the summary_hash the orchestrator must post back to `food_place_order` to confirm. Read-only.",

          "x-lumo-tool": true,
          "x-lumo-cost-tier": "low",
          "x-lumo-requires-confirmation": false,
          "x-lumo-pii-required": [],
          "x-lumo-intent-tags": ["price_food_cart"],

          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/FoodPriceCartRequest" },
              },
            },
          },
          responses: {
            "200": {
              description: "Priced cart",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/FoodPricedCartResponse" },
                },
              },
            },
            "400": { $ref: "#/components/responses/BadRequest" },
            "404": { $ref: "#/components/responses/RestaurantOrItemNotFound" },
            "409": { $ref: "#/components/responses/RestaurantClosed" },
          },
        },
      },

      "/api/tools/food_place_order": {
        post: {
          operationId: "food_place_order",
          summary: "Place a food order (money-moving)",
          description:
            "Money tool. The orchestrator MUST have the user's explicit confirmation of the full cart before calling. Body carries the priced cart from `food_price_cart`, a `summary_hash` (sha256 of the canonical cart summary), and `user_confirmed: true`. Server re-derives the hash from the posted cart; if it doesn't match, returns 409 `confirmation_required` with `expected_summary_hash` so the shell can re-confirm.",

          "x-lumo-tool": true,
          "x-lumo-cost-tier": "money",
          "x-lumo-requires-confirmation": "structured-cart",
          // Every money tool must declare its cancel counterpart.
          // validateCancellationProtocol enforces this at registry load.
          "x-lumo-cancels": "food_cancel_order",
          "x-lumo-pii-required": [
            "name",
            "email",
            "phone",
            "payment_method_id",
            "address",
          ],
          "x-lumo-intent-tags": ["place_food_order"],

          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/FoodPlaceOrderRequest" },
              },
            },
          },
          responses: {
            "200": {
              description: "Order placed",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/FoodPlaceOrderResponse" },
                },
              },
            },
            "400": { $ref: "#/components/responses/BadRequest" },
            "402": { $ref: "#/components/responses/PaymentFailed" },
            "409": { $ref: "#/components/responses/ConfirmationRequired" },
          },
        },
      },

      "/api/tools/food_cancel_order": {
        post: {
          operationId: "food_cancel_order",
          summary: "Cancel a food order (Saga rollback)",
          description:
            "Cancel an order created by `food_place_order`. Compensating action the Saga invokes during compound-trip rollback — MUST NOT prompt the user. Idempotent: a repeat call with the same order_id returns 200 with `already_cancelled: true`. Kitchen may have already accepted — compensation-kind is `best-effort`, so refund_amount may be less than total.",

          "x-lumo-tool": true,
          "x-lumo-cost-tier": "free",
          // MUST be literal false — the Saga has no user in the loop.
          "x-lumo-requires-confirmation": false,
          // Bidirectional pairing with the forward money tool. Both
          // sides must point at each other or the SDK validator fails.
          "x-lumo-cancel-for": "food_place_order",
          "x-lumo-compensation-kind": "best-effort",
          "x-lumo-pii-required": [],
          "x-lumo-intent-tags": ["cancel_food_order"],

          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/FoodCancelOrderRequest" },
              },
            },
          },
          responses: {
            "200": {
              description: "Order cancelled (or idempotent repeat)",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/FoodCancelOrderResponse" },
                },
              },
            },
            "400": { $ref: "#/components/responses/BadRequest" },
            "404": { $ref: "#/components/responses/OrderNotFound" },
          },
        },
      },
    },

    // ────────────────────────────────────────────────────────────────
    // Components — schemas
    // ────────────────────────────────────────────────────────────────
    components: {
      schemas: {
        Metro: {
          type: "string",
          enum: ["austin", "los_angeles", "san_francisco", "chicago"],
          description: "Lumo-serviced metro. Scopes search results.",
        },
        Cuisine: {
          type: "string",
          enum: [
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
          ],
        },

        // Requests
        FoodSearchRequest: {
          type: "object",
          additionalProperties: false,
          properties: {
            query: {
              type: "string",
              description: "Free-text match against name, tags, cuisine, menu items.",
              maxLength: 128,
            },
            cuisine: { $ref: "#/components/schemas/Cuisine" },
            metro: { $ref: "#/components/schemas/Metro" },
            sort: {
              type: "string",
              enum: ["rating", "distance", "eta", "price_low"],
              default: "rating",
            },
            max_eta_minutes: { type: "integer", minimum: 1, maximum: 240 },
            limit: { type: "integer", minimum: 1, maximum: 25, default: 10 },
          },
        },

        FoodGetRestaurantMenuRequest: {
          type: "object",
          additionalProperties: false,
          required: ["restaurant_id"],
          properties: {
            restaurant_id: {
              type: "string",
              minLength: 1,
              description:
                "id of a restaurant returned by food_search_restaurants.",
            },
          },
        },

        FoodMenuItemModifier: {
          type: "object",
          additionalProperties: false,
          required: ["name", "options"],
          properties: {
            name: { type: "string" },
            options: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["label", "delta_cents"],
                properties: {
                  label: { type: "string" },
                  delta_cents: { type: "integer" },
                },
              },
            },
            default: { type: "string" },
          },
        },

        FoodMenuItem: {
          type: "object",
          additionalProperties: false,
          required: [
            "item_id",
            "name",
            "description",
            "unit_price_cents",
            "category",
          ],
          properties: {
            item_id: { type: "string" },
            name: { type: "string" },
            description: { type: "string" },
            unit_price_cents: { type: "integer", minimum: 0 },
            category: { type: "string" },
            modifiers: {
              type: "array",
              items: { $ref: "#/components/schemas/FoodMenuItemModifier" },
            },
          },
        },

        FoodGetRestaurantMenuResponse: {
          type: "object",
          additionalProperties: false,
          required: ["restaurant_id", "restaurant_name", "is_open", "menu"],
          properties: {
            restaurant_id: { type: "string" },
            restaurant_name: { type: "string" },
            is_open: { type: "boolean" },
            menu: {
              type: "array",
              items: { $ref: "#/components/schemas/FoodMenuItem" },
            },
          },
        },

        FoodPriceCartLine: {
          type: "object",
          additionalProperties: false,
          required: ["item_id", "quantity"],
          properties: {
            item_id: { type: "string", minLength: 1 },
            quantity: { type: "integer", minimum: 1, maximum: 50 },
            modifiers: {
              type: "object",
              additionalProperties: { type: "string" },
              description: "Selected option per modifier group, e.g. {\"Crust\": \"Thin\"}.",
            },
            notes: { type: "string", maxLength: 256 },
          },
        },
        FoodPriceCartRequest: {
          type: "object",
          additionalProperties: false,
          required: ["restaurant_id", "lines"],
          properties: {
            restaurant_id: { type: "string", minLength: 1 },
            lines: {
              type: "array",
              minItems: 1,
              maxItems: 50,
              items: { $ref: "#/components/schemas/FoodPriceCartLine" },
            },
          },
        },

        FoodPlaceOrderRequest: {
          type: "object",
          additionalProperties: false,
          required: [
            "cart",
            "delivery_address",
            "payment_method_id",
            "summary_hash",
            "user_confirmed",
          ],
          properties: {
            cart: { $ref: "#/components/schemas/Cart" },
            delivery_address: { type: "string", minLength: 1, maxLength: 512 },
            payment_method_id: {
              type: "string",
              description:
                "Stripe PaymentMethod id — the agent never sees raw card details.",
            },
            summary_hash: {
              type: "string",
              description: "sha256 hex of the canonical cart summary the user confirmed.",
              minLength: 64,
              maxLength: 64,
            },
            user_confirmed: { type: "boolean", const: true },
            contact: {
              type: "object",
              additionalProperties: false,
              properties: {
                name: { type: "string" },
                email: { type: "string", format: "email" },
                phone: { type: "string" },
              },
            },
          },
        },

        FoodCancelOrderRequest: {
          type: "object",
          additionalProperties: false,
          required: ["order_id"],
          properties: {
            order_id: {
              type: "string",
              minLength: 1,
              description: "order_id returned by a prior food_place_order call.",
            },
            reason: {
              type: "string",
              maxLength: 512,
              description:
                "Free-form context captured in the audit log, e.g. 'trip_rollback:flight_leg_failed'.",
            },
          },
        },

        // Responses
        Restaurant: {
          type: "object",
          additionalProperties: false,
          required: [
            "id",
            "name",
            "cuisine",
            "metro",
            "rating",
            "review_count",
            "price_level",
            "distance_miles",
            "eta_minutes",
            "is_open",
            "tags",
          ],
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            cuisine: {
              type: "array",
              items: { $ref: "#/components/schemas/Cuisine" },
            },
            metro: { $ref: "#/components/schemas/Metro" },
            rating: { type: "number", minimum: 0, maximum: 5 },
            review_count: { type: "integer", minimum: 0 },
            price_level: { type: "integer", minimum: 1, maximum: 4 },
            distance_miles: { type: "number", minimum: 0 },
            eta_minutes: { type: "integer", minimum: 0 },
            is_open: { type: "boolean" },
            tags: { type: "array", items: { type: "string" } },
          },
        },
        FoodSearchResponse: {
          type: "object",
          additionalProperties: false,
          required: ["restaurants"],
          properties: {
            restaurants: {
              type: "array",
              items: { $ref: "#/components/schemas/Restaurant" },
            },
          },
        },

        CartLine: {
          type: "object",
          additionalProperties: false,
          required: ["item_id", "name", "quantity", "unit_price_cents", "selected_modifiers"],
          properties: {
            item_id: { type: "string" },
            name: { type: "string" },
            quantity: { type: "integer", minimum: 1 },
            unit_price_cents: { type: "integer", minimum: 0 },
            selected_modifiers: {
              type: "object",
              additionalProperties: { type: "string" },
            },
            notes: { type: "string" },
          },
        },
        Cart: {
          type: "object",
          additionalProperties: false,
          required: [
            "restaurant_id",
            "restaurant_name",
            "lines",
            "subtotal_cents",
            "delivery_fee_cents",
            "service_fee_cents",
            "tax_cents",
            "total_cents",
            "eta_minutes",
          ],
          properties: {
            restaurant_id: { type: "string" },
            restaurant_name: { type: "string" },
            lines: {
              type: "array",
              items: { $ref: "#/components/schemas/CartLine" },
            },
            subtotal_cents: { type: "integer", minimum: 0 },
            delivery_fee_cents: { type: "integer", minimum: 0 },
            service_fee_cents: { type: "integer", minimum: 0 },
            tax_cents: { type: "integer", minimum: 0 },
            total_cents: { type: "integer", minimum: 0 },
            eta_minutes: { type: "integer", minimum: 0 },
          },
        },
        FoodPricedCartResponse: {
          type: "object",
          // The SDK attaches `_lumo_summary` at wire time; allow it.
          additionalProperties: true,
          required: ["cart"],
          properties: {
            cart: { $ref: "#/components/schemas/Cart" },
            _lumo_summary: {
              type: "object",
              description: "Attached by @lumo/agent-sdk's attachSummary helper. Contains the summary_hash the shell echoes back to food_place_order.",
              additionalProperties: true,
            },
          },
        },

        FoodPlaceOrderResponse: {
          type: "object",
          additionalProperties: false,
          required: ["order_id", "status", "total_amount", "total_currency"],
          properties: {
            order_id: { type: "string" },
            status: { type: "string", enum: ["placed"] },
            total_amount: {
              type: "string",
              description: "Decimal string, e.g. '27.48'. Avoids float drift.",
            },
            total_currency: { type: "string", minLength: 3, maxLength: 3 },
            placed_at: { type: "string", format: "date-time" },
            estimated_delivery_at: { type: "string", format: "date-time" },
            delivery_address: { type: "string" },
            cart: { $ref: "#/components/schemas/Cart" },
          },
        },

        FoodCancelOrderResponse: {
          type: "object",
          additionalProperties: true,
          required: ["order_id", "status"],
          properties: {
            order_id: { type: "string" },
            status: { type: "string", enum: ["cancelled"] },
            refund_amount: {
              type: "string",
              description:
                "Decimal string. May be less than total if the kitchen already accepted (compensation-kind is best-effort).",
            },
            refund_currency: { type: "string", minLength: 3, maxLength: 3 },
            cancelled_at: { type: "string", format: "date-time" },
            already_cancelled: {
              type: "boolean",
              description:
                "Present and true when this is an idempotent repeat of a prior cancel.",
            },
          },
        },

        // Error envelope — stable across all tool routes.
        ErrorEnvelope: {
          type: "object",
          additionalProperties: false,
          required: ["error"],
          properties: {
            error: { type: "string" },
            message: { type: "string" },
            details: { type: "object", additionalProperties: true },
          },
        },
      },

      responses: {
        BadRequest: {
          description: "Request body failed validation",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorEnvelope" },
            },
          },
        },
        RateLimited: {
          description: "Too many requests",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorEnvelope" },
            },
          },
        },
        RestaurantOrItemNotFound: {
          description: "restaurant_id unknown, or one of the item_ids does not belong to the restaurant.",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorEnvelope" },
            },
          },
        },
        RestaurantClosed: {
          description: "Restaurant is not currently accepting orders.",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorEnvelope" },
            },
          },
        },
        PaymentFailed: {
          description: "Payment method declined (stub returns this rarely).",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorEnvelope" },
            },
          },
        },
        ConfirmationRequired: {
          description:
            "summary_hash did not match server-computed hash; user must re-confirm. Response details include `expected_summary_hash`.",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorEnvelope" },
            },
          },
        },
        OrderNotFound: {
          description: "Unknown order_id on this agent.",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorEnvelope" },
            },
          },
        },
      },
    },
  } as const;

  return NextResponse.json(doc, {
    status: 200,
    headers: {
      "cache-control": "public, max-age=60, s-maxage=300",
      "access-control-allow-origin": "*",
    },
  });
}
