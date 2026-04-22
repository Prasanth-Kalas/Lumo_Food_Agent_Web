/**
 * Postgres client for Lumo.
 *
 * Uses @neondatabase/serverless — the HTTP-over-fetch driver that works inside
 * Vercel serverless & edge runtimes without a connection pool. That matters
 * because on Vercel every request may spin up a fresh Node isolate, and a
 * traditional pg pool would leak connections fast.
 *
 * Graceful fallback: if no DATABASE_URL / POSTGRES_URL is set, getSql()
 * returns null and callers fall back to in-memory Maps. This lets the app keep
 * working locally and during the window between `vercel env pull` and the
 * first deploy after attaching the DB.
 */
import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

// Prefer the non-pooled URL for simple reads; both work via neon().
// Vercel's Postgres integration injects all of these.
function resolveUrl(): string | null {
  return (
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    process.env.POSTGRES_URL_NON_POOLING ||
    null
  );
}

// Cache the client per-isolate so we don't re-parse the URL on every call.
let cached: NeonQueryFunction<false, false> | null = null;
let cachedUrl: string | null = null;
let migrationPromise: Promise<void> | null = null;

export function getSql(): NeonQueryFunction<false, false> | null {
  const url = resolveUrl();
  if (!url) return null;
  if (cached && cachedUrl === url) return cached;
  cached = neon(url);
  cachedUrl = url;
  return cached;
}

export function hasDb(): boolean {
  return resolveUrl() !== null;
}

/**
 * Idempotent schema migration. We keep it inline (not a separate migration
 * tool) because the MVP only has three tables and Vercel Postgres can't run
 * migrations on deploy hooks without extra tooling.
 *
 * Safe to call on every cold start — CREATE TABLE IF NOT EXISTS is cheap and
 * runs once per isolate thanks to migrationPromise caching.
 */
export async function ensureSchema(): Promise<void> {
  if (migrationPromise) return migrationPromise;
  const sql = getSql();
  if (!sql) return;

  migrationPromise = (async () => {
    await sql`
      CREATE TABLE IF NOT EXISTS cart_snapshots (
        session_id        TEXT PRIMARY KEY,
        restaurant_id     TEXT NOT NULL,
        cart              JSONB NOT NULL,
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS orders (
        id                      TEXT PRIMARY KEY,
        session_id              TEXT NOT NULL,
        cart                    JSONB NOT NULL,
        address                 TEXT NOT NULL,
        status                  TEXT NOT NULL,
        placed_at               TIMESTAMPTZ NOT NULL,
        estimated_delivery_at   TIMESTAMPTZ NOT NULL
      )
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS orders_session_placed_idx
      ON orders (session_id, placed_at DESC)
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS confirmation_gates (
        session_id        TEXT PRIMARY KEY,
        last_summary_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    // Sprint C: Stripe PaymentIntents. One active PI per session at a time;
    // overwrite on cart changes so we never charge a stale amount.
    await sql`
      CREATE TABLE IF NOT EXISTS payment_intents (
        session_id          TEXT PRIMARY KEY,
        payment_intent_id   TEXT NOT NULL,
        client_secret       TEXT NOT NULL,
        amount_cents        INTEGER NOT NULL,
        status              TEXT NOT NULL,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    // Record the PI on the order for reconciliation.
    await sql`
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_intent_id TEXT
    `;
    // Sprint D guardrail: audit every build_cart call so we can prove in prod
    // that the evidence gate is being respected. Append-only, tiny rows.
    // Includes accepted AND rejected attempts so we can see when the model
    // tried to add without proper evidence.
    await sql`
      CREATE TABLE IF NOT EXISTS cart_add_audit (
        id                  BIGSERIAL PRIMARY KEY,
        session_id          TEXT NOT NULL,
        outcome             TEXT NOT NULL,
        restaurant_id       TEXT,
        item_count          INTEGER NOT NULL,
        user_intent_message TEXT NOT NULL,
        evidence            JSONB NOT NULL,
        reject_reason       TEXT,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS cart_add_audit_session_created_idx
      ON cart_add_audit (session_id, created_at DESC)
    `;
    // Sprint D guardrail (payment side): audit every create_payment_intent and
    // place_order attempt. Same log-only, append-only pattern as cart_add_audit
    // so we can answer "how often do we reject fabricated confirmations?" and
    // "did the amount-mismatch refund path fire?" from /api/lumo-verify without
    // leaking row-level data. Amount stored in cents, never card detail.
    await sql`
      CREATE TABLE IF NOT EXISTS payment_attempt_audit (
        id                  BIGSERIAL PRIMARY KEY,
        session_id          TEXT NOT NULL,
        stage               TEXT NOT NULL,
        outcome             TEXT NOT NULL,
        payment_intent_id   TEXT,
        amount_cents        INTEGER,
        reason              TEXT,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS payment_attempt_audit_session_created_idx
      ON payment_attempt_audit (session_id, created_at DESC)
    `;
  })().catch((err) => {
    // Don't poison the promise cache if migration fails — next call retries.
    migrationPromise = null;
    throw err;
  });

  return migrationPromise;
}
