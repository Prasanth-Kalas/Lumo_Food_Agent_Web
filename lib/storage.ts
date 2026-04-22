/**
 * Storage abstraction for cart, order, and confirmation-gate state.
 *
 * Why this exists:
 *   tools.ts was reaching directly into three module-level Maps. That works
 *   for a single-instance demo, but in a Vercel serverless world every
 *   request may land on a fresh isolate — so the Maps evaporate between
 *   calls. The fix is Postgres. The interface below lets tools.ts stay
 *   clean while we switch the backing store transparently.
 *
 * Two implementations:
 *   - PostgresStorage: persistent, multi-instance safe. Used when
 *     DATABASE_URL / POSTGRES_URL is set (i.e. Vercel deployments and local
 *     dev after `vercel env pull`).
 *   - MemoryStorage: module-level Maps. Used when no DB is configured — keeps
 *     `npm run dev` working offline and in CI.
 *
 * We pick at module init by reading the env once. If you swap envs you need
 * a fresh process; serverless isolates do that automatically.
 */

import { ensureSchema, getSql, hasDb } from "./db";
import type { Cart, Order, PaymentIntentRecord } from "./types";

export interface LumoStorage {
  getCart(sessionId: string): Promise<Cart | null>;
  setCart(sessionId: string, cart: Cart): Promise<void>;
  clearCart(sessionId: string): Promise<void>;

  getOrderHistory(sessionId: string, limit?: number): Promise<Order[]>;
  findOrder(sessionId: string, orderId: string): Promise<Order | null>;
  addOrder(sessionId: string, order: Order): Promise<void>;

  /** epoch ms of the last cart summary shown to the user. null if never. */
  getLastSummaryAt(sessionId: string): Promise<number | null>;
  setLastSummaryAt(sessionId: string, ts: number): Promise<void>;
  clearLastSummaryAt(sessionId: string): Promise<void>;

  /** Sprint C — Stripe PaymentIntent per session (at most one active). */
  getPaymentIntent(sessionId: string): Promise<PaymentIntentRecord | null>;
  setPaymentIntent(sessionId: string, rec: PaymentIntentRecord): Promise<void>;
  clearPaymentIntent(sessionId: string): Promise<void>;
}

// ---------- In-memory implementation --------------------------------------

class MemoryStorage implements LumoStorage {
  private carts = new Map<string, Cart>();
  private orders = new Map<string, Order[]>();
  private summaries = new Map<string, number>();
  private paymentIntents = new Map<string, PaymentIntentRecord>();

  async getCart(sessionId: string) {
    return this.carts.get(sessionId) ?? null;
  }
  async setCart(sessionId: string, cart: Cart) {
    this.carts.set(sessionId, cart);
  }
  async clearCart(sessionId: string) {
    this.carts.delete(sessionId);
  }

  async getOrderHistory(sessionId: string, limit = 10) {
    return (this.orders.get(sessionId) ?? []).slice(0, limit);
  }
  async findOrder(sessionId: string, orderId: string) {
    return (
      (this.orders.get(sessionId) ?? []).find((o) => o.id === orderId) ?? null
    );
  }
  async addOrder(sessionId: string, order: Order) {
    const history = this.orders.get(sessionId) ?? [];
    history.unshift(order);
    this.orders.set(sessionId, history);
  }

  async getLastSummaryAt(sessionId: string) {
    return this.summaries.get(sessionId) ?? null;
  }
  async setLastSummaryAt(sessionId: string, ts: number) {
    this.summaries.set(sessionId, ts);
  }
  async clearLastSummaryAt(sessionId: string) {
    this.summaries.delete(sessionId);
  }

  async getPaymentIntent(sessionId: string) {
    return this.paymentIntents.get(sessionId) ?? null;
  }
  async setPaymentIntent(sessionId: string, rec: PaymentIntentRecord) {
    this.paymentIntents.set(sessionId, rec);
  }
  async clearPaymentIntent(sessionId: string) {
    this.paymentIntents.delete(sessionId);
  }
}

// ---------- Postgres implementation ---------------------------------------

class PostgresStorage implements LumoStorage {
  async getCart(sessionId: string): Promise<Cart | null> {
    const sql = getSql();
    if (!sql) return null;
    await ensureSchema();
    const rows = (await sql`
      SELECT cart FROM cart_snapshots WHERE session_id = ${sessionId}
    `) as Array<{ cart: Cart }>;
    return rows[0]?.cart ?? null;
  }

  async setCart(sessionId: string, cart: Cart): Promise<void> {
    const sql = getSql();
    if (!sql) return;
    await ensureSchema();
    await sql`
      INSERT INTO cart_snapshots (session_id, restaurant_id, cart, updated_at)
      VALUES (${sessionId}, ${cart.restaurant_id}, ${JSON.stringify(cart)}::jsonb, NOW())
      ON CONFLICT (session_id) DO UPDATE
      SET restaurant_id = EXCLUDED.restaurant_id,
          cart = EXCLUDED.cart,
          updated_at = NOW()
    `;
  }

  async clearCart(sessionId: string): Promise<void> {
    const sql = getSql();
    if (!sql) return;
    await ensureSchema();
    await sql`DELETE FROM cart_snapshots WHERE session_id = ${sessionId}`;
  }

  async getOrderHistory(sessionId: string, limit = 10): Promise<Order[]> {
    const sql = getSql();
    if (!sql) return [];
    await ensureSchema();
    const rows = (await sql`
      SELECT id, cart, address, status, placed_at, estimated_delivery_at, payment_intent_id
      FROM orders
      WHERE session_id = ${sessionId}
      ORDER BY placed_at DESC
      LIMIT ${limit}
    `) as Array<{
      id: string;
      cart: Cart;
      address: string;
      status: Order["status"];
      placed_at: Date | string;
      estimated_delivery_at: Date | string;
      payment_intent_id: string | null;
    }>;

    return rows.map((r) => ({
      id: r.id,
      cart: r.cart,
      address: r.address,
      status: r.status,
      placed_at: toIso(r.placed_at),
      estimated_delivery_at: toIso(r.estimated_delivery_at),
      ...(r.payment_intent_id ? { payment_intent_id: r.payment_intent_id } : {}),
    }));
  }

  async findOrder(sessionId: string, orderId: string): Promise<Order | null> {
    const sql = getSql();
    if (!sql) return null;
    await ensureSchema();
    const rows = (await sql`
      SELECT id, cart, address, status, placed_at, estimated_delivery_at, payment_intent_id
      FROM orders
      WHERE session_id = ${sessionId} AND id = ${orderId}
      LIMIT 1
    `) as Array<{
      id: string;
      cart: Cart;
      address: string;
      status: Order["status"];
      placed_at: Date | string;
      estimated_delivery_at: Date | string;
      payment_intent_id: string | null;
    }>;
    const r = rows[0];
    if (!r) return null;
    return {
      id: r.id,
      cart: r.cart,
      address: r.address,
      status: r.status,
      placed_at: toIso(r.placed_at),
      estimated_delivery_at: toIso(r.estimated_delivery_at),
      ...(r.payment_intent_id ? { payment_intent_id: r.payment_intent_id } : {}),
    };
  }

  async addOrder(sessionId: string, order: Order): Promise<void> {
    const sql = getSql();
    if (!sql) return;
    await ensureSchema();
    await sql`
      INSERT INTO orders (id, session_id, cart, address, status, placed_at, estimated_delivery_at, payment_intent_id)
      VALUES (
        ${order.id},
        ${sessionId},
        ${JSON.stringify(order.cart)}::jsonb,
        ${order.address},
        ${order.status},
        ${order.placed_at},
        ${order.estimated_delivery_at},
        ${order.payment_intent_id ?? null}
      )
    `;
  }

  async getLastSummaryAt(sessionId: string): Promise<number | null> {
    const sql = getSql();
    if (!sql) return null;
    await ensureSchema();
    const rows = (await sql`
      SELECT last_summary_at FROM confirmation_gates WHERE session_id = ${sessionId}
    `) as Array<{ last_summary_at: Date | string }>;
    const raw = rows[0]?.last_summary_at;
    if (!raw) return null;
    const d = typeof raw === "string" ? new Date(raw) : raw;
    return d.getTime();
  }

  async setLastSummaryAt(sessionId: string, ts: number): Promise<void> {
    const sql = getSql();
    if (!sql) return;
    await ensureSchema();
    const iso = new Date(ts).toISOString();
    await sql`
      INSERT INTO confirmation_gates (session_id, last_summary_at)
      VALUES (${sessionId}, ${iso})
      ON CONFLICT (session_id) DO UPDATE SET last_summary_at = EXCLUDED.last_summary_at
    `;
  }

  async clearLastSummaryAt(sessionId: string): Promise<void> {
    const sql = getSql();
    if (!sql) return;
    await ensureSchema();
    await sql`DELETE FROM confirmation_gates WHERE session_id = ${sessionId}`;
  }

  async getPaymentIntent(sessionId: string): Promise<PaymentIntentRecord | null> {
    const sql = getSql();
    if (!sql) return null;
    await ensureSchema();
    const rows = (await sql`
      SELECT payment_intent_id, client_secret, amount_cents, status
      FROM payment_intents
      WHERE session_id = ${sessionId}
    `) as Array<PaymentIntentRecord>;
    return rows[0] ?? null;
  }

  async setPaymentIntent(sessionId: string, rec: PaymentIntentRecord): Promise<void> {
    const sql = getSql();
    if (!sql) return;
    await ensureSchema();
    await sql`
      INSERT INTO payment_intents
        (session_id, payment_intent_id, client_secret, amount_cents, status, created_at, updated_at)
      VALUES
        (${sessionId}, ${rec.payment_intent_id}, ${rec.client_secret}, ${rec.amount_cents}, ${rec.status}, NOW(), NOW())
      ON CONFLICT (session_id) DO UPDATE
      SET payment_intent_id = EXCLUDED.payment_intent_id,
          client_secret     = EXCLUDED.client_secret,
          amount_cents      = EXCLUDED.amount_cents,
          status            = EXCLUDED.status,
          updated_at        = NOW()
    `;
  }

  async clearPaymentIntent(sessionId: string): Promise<void> {
    const sql = getSql();
    if (!sql) return;
    await ensureSchema();
    await sql`DELETE FROM payment_intents WHERE session_id = ${sessionId}`;
  }
}

function toIso(v: Date | string): string {
  return typeof v === "string" ? v : v.toISOString();
}

// ---------- Singleton selection -------------------------------------------

let instance: LumoStorage | null = null;

export function getStorage(): LumoStorage {
  if (instance) return instance;
  instance = hasDb() ? new PostgresStorage() : new MemoryStorage();
  return instance;
}

export function storageBackend(): "postgres" | "memory" {
  return hasDb() ? "postgres" : "memory";
}
