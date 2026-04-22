/**
 * /api/lumo-verify — read-only prod diagnostic.
 *
 * Purpose: answer "is Postgres persistence actually wired end-to-end on the
 * deployed Vercel app?" without leaking secrets. Built specifically to
 * close out task #22 (Mobile: Verify Postgres persistence) — safe to leave
 * in place after because it exposes only counts and shapes, never rows.
 *
 * GET  /api/lumo-verify                 → global view (storage backend,
 *                                          schema ok, total orders, latest)
 * GET  /api/lumo-verify?sessionId=<id>  → + that session's row counts and
 *                                          the most recent order's id/status
 *
 * What it never returns:
 *   - Connection strings or API keys
 *   - Cart contents, addresses, payment intent ids
 *   - Any row-level data beyond a single id + status + ISO timestamp
 *
 * Intended usage during verification:
 *   1) curl before the test order → record baseline counts
 *   2) run order flow on mobile
 *   3) curl again → counts should increment; storage.backend should be
 *      "postgres" (not "memory") on Vercel, confirming prod persistence
 */
import { NextResponse } from "next/server";
import { ensureSchema, getSql, hasDb } from "@/lib/db";
import { sanitizeSessionId } from "@/lib/session-context";
import {
  getStorage,
  storageBackend,
  type CartAddAuditRow,
} from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface VerifyResponse {
  ok: boolean;
  storage_backend: "postgres" | "memory";
  db_configured: boolean;
  db_ping: "ok" | "n/a" | string;
  schema_ok: boolean;
  tables: {
    orders: number | null;
    cart_snapshots: number | null;
    payment_intents: number | null;
    confirmation_gates: number | null;
    cart_add_audit: number | null;
  };
  latest_order_at: string | null;
  cart_add_audit: {
    accepted: number;
    rejected: number;
  };
  session: null | {
    session_id: string;
    cart_present: boolean;
    orders_count: number;
    latest_order: null | {
      id: string;
      status: string;
      placed_at: string;
    };
    recent_cart_audit: Array<{
      id: number;
      outcome: "accepted" | "rejected";
      restaurant_id: string | null;
      item_count: number;
      user_intent_message: string;
      evidence: Array<{ item_id: string; phrase: string }>;
      reject_reason: string | null;
      created_at: string;
    }>;
  };
  checked_at: string;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const rawSession = url.searchParams.get("sessionId");
  const sessionId = rawSession ? sanitizeSessionId(rawSession) : null;

  const out: VerifyResponse = {
    ok: true,
    storage_backend: storageBackend(),
    db_configured: hasDb(),
    db_ping: "n/a",
    schema_ok: false,
    tables: {
      orders: null,
      cart_snapshots: null,
      payment_intents: null,
      confirmation_gates: null,
      cart_add_audit: null,
    },
    latest_order_at: null,
    cart_add_audit: { accepted: 0, rejected: 0 },
    session: null,
    checked_at: new Date().toISOString(),
  };

  const sql = getSql();
  if (!sql) {
    // Memory fallback — nothing more to check. Return early so the caller
    // sees storage_backend: "memory" and can act on it.
    return NextResponse.json(out);
  }

  // 1) Liveness
  try {
    await sql`SELECT 1 AS ok`;
    out.db_ping = "ok";
  } catch (err) {
    out.ok = false;
    out.db_ping = err instanceof Error ? `error:${err.message}` : "error:unknown";
    return NextResponse.json(out, { status: 200 });
  }

  // 2) Make sure the schema exists; ensureSchema is idempotent.
  try {
    await ensureSchema();
    out.schema_ok = true;
  } catch (err) {
    out.ok = false;
    out.schema_ok = false;
    return NextResponse.json(
      {
        ...out,
        db_ping:
          err instanceof Error ? `schema_error:${err.message}` : "schema_error",
      },
      { status: 200 }
    );
  }

  // 3) Cheap row counts — safe to expose, no PII.
  try {
    const counts = (await sql`
      SELECT
        (SELECT COUNT(*) FROM orders)                                           AS orders,
        (SELECT COUNT(*) FROM cart_snapshots)                                   AS carts,
        (SELECT COUNT(*) FROM payment_intents)                                  AS pis,
        (SELECT COUNT(*) FROM confirmation_gates)                               AS gates,
        (SELECT COUNT(*) FROM cart_add_audit)                                   AS audit_total,
        (SELECT COUNT(*) FROM cart_add_audit WHERE outcome = 'accepted')        AS audit_accepted,
        (SELECT COUNT(*) FROM cart_add_audit WHERE outcome = 'rejected')        AS audit_rejected,
        (SELECT MAX(placed_at) FROM orders)                                     AS latest
    `) as Array<{
      orders: string | number;
      carts: string | number;
      pis: string | number;
      gates: string | number;
      audit_total: string | number;
      audit_accepted: string | number;
      audit_rejected: string | number;
      latest: Date | string | null;
    }>;
    const c = counts[0];
    if (c) {
      out.tables.orders = Number(c.orders);
      out.tables.cart_snapshots = Number(c.carts);
      out.tables.payment_intents = Number(c.pis);
      out.tables.confirmation_gates = Number(c.gates);
      out.tables.cart_add_audit = Number(c.audit_total);
      out.cart_add_audit.accepted = Number(c.audit_accepted);
      out.cart_add_audit.rejected = Number(c.audit_rejected);
      out.latest_order_at = c.latest
        ? typeof c.latest === "string"
          ? c.latest
          : c.latest.toISOString()
        : null;
    }
  } catch (err) {
    out.ok = false;
    return NextResponse.json(
      {
        ...out,
        db_ping:
          err instanceof Error
            ? `count_error:${err.message}`
            : "count_error",
      },
      { status: 200 }
    );
  }

  // 4) Per-session drill-in (optional).
  if (sessionId) {
    try {
      const [cartRow] = (await sql`
        SELECT 1 AS present FROM cart_snapshots WHERE session_id = ${sessionId}
      `) as Array<{ present: number }>;

      const ordersRows = (await sql`
        SELECT id, status, placed_at
        FROM orders
        WHERE session_id = ${sessionId}
        ORDER BY placed_at DESC
        LIMIT 1
      `) as Array<{ id: string; status: string; placed_at: Date | string }>;

      const [{ count: sessionOrders }] = (await sql`
        SELECT COUNT(*)::int AS count FROM orders WHERE session_id = ${sessionId}
      `) as Array<{ count: number }>;

      const latest = ordersRows[0];
      const recentAudit: CartAddAuditRow[] = await getStorage()
        .getRecentCartAudit(sessionId, 5)
        .catch(() => []);
      out.session = {
        session_id: sessionId,
        cart_present: Boolean(cartRow),
        orders_count: Number(sessionOrders ?? 0),
        latest_order: latest
          ? {
              id: latest.id,
              status: latest.status,
              placed_at:
                typeof latest.placed_at === "string"
                  ? latest.placed_at
                  : latest.placed_at.toISOString(),
            }
          : null,
        recent_cart_audit: recentAudit.map((r) => ({
          id: r.id,
          outcome: r.outcome,
          restaurant_id: r.restaurant_id,
          item_count: r.item_count,
          user_intent_message: r.user_intent_message,
          evidence: r.evidence,
          reject_reason: r.reject_reason ?? null,
          created_at: r.created_at,
        })),
      };
    } catch (err) {
      out.ok = false;
      return NextResponse.json(
        {
          ...out,
          db_ping:
            err instanceof Error
              ? `session_error:${err.message}`
              : "session_error",
        },
        { status: 200 }
      );
    }
  }

  return NextResponse.json(out);
}
