/**
 * Stripe client for Lumo.
 *
 * Mirrors the graceful-fallback pattern from lib/db.ts: if no STRIPE_SECRET_KEY
 * is set, getStripe() returns null and callers fall back to the demo
 * cash-on-delivery path. That keeps `npm run dev` working with zero Stripe
 * setup, and it gives us a clean toggle when we want to demo the non-payment
 * flow to a prospect.
 *
 * Server-only. The publishable key travels to the client via
 * NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY — Next exposes that automatically.
 * The secret key lives here and nowhere else.
 *
 * apiVersion is pinned so a new Stripe release doesn't silently change the
 * response shape between our SDK and theirs.
 */
import Stripe from "stripe";

// Cache per isolate — creating Stripe clients is cheap but not free, and
// serverless cold-starts benefit from skipping redundant constructors.
let cached: Stripe | null = null;
let cachedKey: string | null = null;

export function getStripe(): Stripe | null {
  const key = process.env.STRIPE_SECRET_KEY || null;
  if (!key) return null;
  if (cached && cachedKey === key) return cached;
  cached = new Stripe(key, {
    // Pin API version. Bump deliberately when we upgrade the SDK + retest.
    apiVersion: "2025-02-24.acacia",
    typescript: true,
    appInfo: {
      name: "Lumo Food Agent",
      version: "0.1.0",
    },
  });
  cachedKey = key;
  return cached;
}

export function hasStripe(): boolean {
  return !!process.env.STRIPE_SECRET_KEY;
}

/** Safe to expose in tool results — the publishable key is designed for clients. */
export function getPublishableKey(): string | null {
  return process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY || null;
}
