/**
 * POST /api/tools/food_get_restaurant_menu
 *
 * READ TOOL. Cost-tier free, no PII, no confirmation gate.
 *
 * food_search_restaurants returns stripped Restaurant cards (no menu) so
 * responses stay small when we're still narrowing candidates. Once the
 * orchestrator has picked a restaurant, it calls THIS tool to discover
 * the item_ids it needs to pass into food_price_cart.
 *
 * Shape is normalized to match what food_price_cart consumes:
 *   - `item_id` (not the internal `id`)
 *   - `unit_price_cents` (not `price_cents`)
 * so the orchestrator can forward items straight into a cart without
 * field-renaming gymnastics.
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import {
  badRequestFromZod,
  errorResponse,
  stripEnvelopeKeys,
} from "@/lib/agent-http";
import { requireToolBearer } from "@/lib/tool-auth";
import { getMenuMock, getRestaurantByIdMock } from "@/lib/mock-data";

const BodySchema = z
  .object({
    restaurant_id: z.string().min(1),
  })
  .strict();

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const principal = requireToolBearer(req, ["food:read"]);
  if (principal instanceof Response) return principal;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return errorResponse("bad_request", 400, "Body must be valid JSON.");
  }

  const parsed = BodySchema.safeParse(stripEnvelopeKeys(raw));
  if (!parsed.success) return badRequestFromZod(parsed.error);

  const restaurant = getRestaurantByIdMock(parsed.data.restaurant_id);
  if (!restaurant) {
    return errorResponse(
      "restaurant_not_found",
      404,
      "No restaurant with that id.",
    );
  }

  const menu = getMenuMock(parsed.data.restaurant_id).map((m) => ({
    item_id: m.id,
    name: m.name,
    description: m.description,
    unit_price_cents: m.price_cents,
    category: m.category,
    ...(m.modifiers ? { modifiers: m.modifiers } : {}),
  }));

  return NextResponse.json(
    {
      restaurant_id: restaurant.id,
      restaurant_name: restaurant.name,
      is_open: restaurant.is_open,
      menu,
    },
    { status: 200, headers: { "cache-control": "no-store" } },
  );
}
