/**
 * POST /api/tools/food_search_restaurants
 *
 * READ TOOL. Cost-tier free, no PII, no confirmation gate.
 * Thin wrapper around the existing mock-data accessor — the PWA uses
 * the same underlying function (via lib/tools.ts).
 *
 * Does NOT call attachSummary: search returns N candidates and the
 * summary/hash only makes sense once the user has committed to a
 * specific cart. That happens in food_price_cart.
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import { searchRestaurantsMock } from "@/lib/mock-data";
import {
  badRequestFromZod,
  errorResponse,
  stripEnvelopeKeys,
} from "@/lib/agent-http";
import { requireToolBearer } from "@/lib/tool-auth";

const CuisineSchema = z.enum([
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
]);
const MetroSchema = z.enum(["austin", "los_angeles", "san_francisco", "chicago"]);

const BodySchema = z
  .object({
    query: z.string().max(128).optional(),
    cuisine: CuisineSchema.optional(),
    metro: MetroSchema.optional(),
    sort: z.enum(["rating", "distance", "eta", "price_low"]).optional(),
    max_eta_minutes: z.number().int().min(1).max(240).optional(),
    limit: z.number().int().min(1).max(25).optional(),
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

  const restaurants = searchRestaurantsMock(parsed.data);

  return NextResponse.json(
    { restaurants },
    {
      status: 200,
      headers: {
        "cache-control": "no-store",
      },
    },
  );
}
