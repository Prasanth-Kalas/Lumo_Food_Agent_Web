"use client";

import type { ToolInvocation } from "ai";
import {
  Check,
  ChefHat,
  Clock,
  MapPin,
  ShoppingBag,
  Star,
  Truck,
  Utensils,
  XCircle,
} from "lucide-react";
import { cn, formatEta, formatPrice } from "@/lib/utils";
import type { Cart, MenuItem, Order, Restaurant } from "@/lib/types";
import { PaymentForm } from "./PaymentForm";

/**
 * Renders rich, tappable cards for every tool result the agent emits.
 * Each branch maps to a `kind` value returned from lib/tools.ts:
 *   restaurants | menu | cart | empty_cart | order_placed |
 *   order_status | order_history | error
 *
 * The onQuickReply callback lets the user tap a card or button to inject
 * a canned message back into the chat — so they can drive the flow with
 * taps OR with typing, their choice.
 */
export function ToolResultRenderer({
  invocation,
  onQuickReply,
}: {
  invocation: ToolInvocation;
  onQuickReply: (text: string) => void;
}) {
  // While the tool is still running, show a subtle "working" pill.
  if (invocation.state !== "result") {
    return <WorkingPill toolName={invocation.toolName} />;
  }

  const result = invocation.result as
    | { kind: "restaurants"; count: number; restaurants: Restaurant[] }
    | { kind: "menu"; restaurant_id: string; restaurant_name: string; items: MenuItem[] }
    | { kind: "cart"; cart: Cart }
    | { kind: "empty_cart" }
    | {
        kind: "payment_required";
        payment_intent_id: string;
        client_secret: string;
        amount_cents: number;
        currency: string;
        publishable_key: string | null;
      }
    | { kind: "payment_skipped"; reason: string; amount_cents: number }
    | { kind: "order_placed"; order: Order }
    | { kind: "order_status"; order: Order }
    | { kind: "order_history"; orders: Order[] }
    | { kind: "error"; message: string };

  switch (result.kind) {
    case "restaurants":
      return (
        <RestaurantList
          restaurants={result.restaurants}
          onPick={(r) =>
            onQuickReply(`Let's go with ${r.name}. Show me the menu.`)
          }
        />
      );

    case "menu":
      return (
        <MenuPreview
          restaurantName={result.restaurant_name}
          items={result.items}
        />
      );

    case "cart":
      return (
        <CartSummary
          cart={result.cart}
          onConfirm={() => onQuickReply("confirm")}
          onCancel={() => onQuickReply("cancel — don't place the order")}
        />
      );

    case "empty_cart":
      return (
        <InfoCard
          icon={<ShoppingBag className="h-4 w-4" />}
          title="Your cart is empty"
          body="Tell me what you're hungry for and I'll build it."
        />
      );

    case "payment_required":
      return (
        <PaymentForm
          clientSecret={result.client_secret}
          publishableKey={result.publishable_key}
          amountCents={result.amount_cents}
          onPaid={() => onQuickReply("payment confirmed")}
        />
      );

    case "payment_skipped":
      // Demo / cash-on-delivery path — agent proceeds without card entry.
      return (
        <InfoCard
          icon={<ShoppingBag className="h-4 w-4" />}
          title="Paying on delivery"
          body={`No card required in demo mode. Total ${formatPrice(
            result.amount_cents
          )}.`}
        />
      );

    case "order_placed":
      return <OrderConfirmation order={result.order} />;

    case "order_status":
      return <OrderStatusCard order={result.order} />;

    case "order_history":
      return <OrderHistory orders={result.orders} onReorder={onQuickReply} />;

    case "error":
      return (
        <InfoCard
          tone="error"
          icon={<XCircle className="h-4 w-4" />}
          title="Something went wrong"
          body={result.message}
        />
      );

    default:
      return null;
  }
}

// -------------------------------------------------------------------------
// Working pill (tool in-flight)
// -------------------------------------------------------------------------

function WorkingPill({ toolName }: { toolName: string }) {
  const label: Record<string, string> = {
    search_restaurants: "Finding restaurants…",
    get_restaurant_menu: "Loading menu…",
    build_cart: "Building your cart…",
    get_cart_summary: "Reviewing your cart…",
    create_payment_intent: "Setting up payment…",
    place_order: "Placing your order…",
    get_order_status: "Checking status…",
    get_order_history: "Pulling recent orders…",
  };
  return (
    <div className="inline-flex items-center gap-2 self-start rounded-full bg-ink-50 px-3 py-1.5 text-xs text-ink-500 ring-1 ring-ink-100">
      <span className="inline-flex">
        <span className="typing-dot" />
        <span className="typing-dot" />
        <span className="typing-dot" />
      </span>
      <span>{label[toolName] ?? "Working…"}</span>
    </div>
  );
}

// -------------------------------------------------------------------------
// Restaurant list
// -------------------------------------------------------------------------

function RestaurantList({
  restaurants,
  onPick,
}: {
  restaurants: Restaurant[];
  onPick: (r: Restaurant) => void;
}) {
  if (restaurants.length === 0) {
    return (
      <InfoCard
        icon={<Utensils className="h-4 w-4" />}
        title="Nothing matched"
        body="Try a different cuisine or loosen the filters."
      />
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {restaurants.map((r) => (
        <RestaurantCard key={r.id} restaurant={r} onPick={() => onPick(r)} />
      ))}
    </div>
  );
}

function RestaurantCard({
  restaurant,
  onPick,
}: {
  restaurant: Restaurant;
  onPick: () => void;
}) {
  const priceLabel = "$".repeat(restaurant.price_level);
  return (
    <button
      type="button"
      onClick={onPick}
      className="group animate-fade-in flex w-full items-start gap-3 rounded-2xl border border-ink-100 bg-white p-3 text-left shadow-card transition hover:-translate-y-0.5 hover:border-lumo-200 hover:shadow-soft"
    >
      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-lumo-50 text-lumo-600 ring-1 ring-lumo-100">
        <ChefHat className="h-5 w-5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <div className="truncate text-[15px] font-semibold text-ink-900">
            {restaurant.name}
          </div>
          {!restaurant.is_open && (
            <span className="shrink-0 rounded-full bg-ink-100 px-2 py-0.5 text-[10px] font-medium text-ink-500">
              Closed
            </span>
          )}
        </div>
        <div className="mt-0.5 truncate text-xs text-ink-500">
          {restaurant.cuisine.join(" · ")} · {priceLabel}
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-600">
          <span className="inline-flex items-center gap-1">
            <Star className="h-3 w-3 fill-amber-400 text-amber-400" />
            <span className="font-medium text-ink-800">
              {restaurant.rating.toFixed(1)}
            </span>
            <span className="text-ink-400">
              ({restaurant.review_count.toLocaleString()})
            </span>
          </span>
          <span className="inline-flex items-center gap-1">
            <Clock className="h-3 w-3" />
            {formatEta(restaurant.eta_minutes)}
          </span>
          <span className="inline-flex items-center gap-1">
            <MapPin className="h-3 w-3" />
            {restaurant.distance_miles.toFixed(1)} mi
          </span>
        </div>
      </div>
      <div className="shrink-0 self-center rounded-full border border-ink-200 px-3 py-1 text-xs font-medium text-ink-700 transition group-hover:border-lumo-300 group-hover:bg-lumo-50 group-hover:text-lumo-700">
        Pick
      </div>
    </button>
  );
}

// -------------------------------------------------------------------------
// Menu preview (first few items, so user can confirm they've got the right spot)
// -------------------------------------------------------------------------

function MenuPreview({
  restaurantName,
  items,
}: {
  restaurantName: string;
  items: MenuItem[];
}) {
  const preview = items.slice(0, 4);
  const more = Math.max(0, items.length - preview.length);
  return (
    <div className="animate-fade-in rounded-2xl border border-ink-100 bg-white p-3 shadow-card">
      <div className="mb-2 flex items-center gap-2 text-[13px] font-semibold text-ink-900">
        <Utensils className="h-4 w-4 text-lumo-500" />
        {restaurantName} menu
      </div>
      <ul className="divide-y divide-ink-100">
        {preview.map((item) => (
          <li key={item.id} className="flex items-start gap-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-ink-900">
                {item.name}
              </div>
              {item.description && (
                <div className="mt-0.5 line-clamp-2 text-xs text-ink-500">
                  {item.description}
                </div>
              )}
            </div>
            <div className="shrink-0 text-sm font-semibold text-ink-900">
              {formatPrice(item.price_cents)}
            </div>
          </li>
        ))}
      </ul>
      {more > 0 && (
        <div className="mt-1 text-center text-xs text-ink-400">
          +{more} more item{more === 1 ? "" : "s"}
        </div>
      )}
    </div>
  );
}

// -------------------------------------------------------------------------
// Cart summary — the screen right before confirmation
// -------------------------------------------------------------------------

function CartSummary({
  cart,
  onConfirm,
  onCancel,
}: {
  cart: Cart;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="animate-fade-in overflow-hidden rounded-2xl border border-ink-100 bg-white shadow-card">
      <div className="flex items-center gap-2 border-b border-ink-100 bg-ink-50 px-4 py-2.5">
        <ShoppingBag className="h-4 w-4 text-lumo-500" />
        <div className="flex-1 text-[13px] font-semibold text-ink-900">
          {cart.restaurant_name}
        </div>
        <div className="inline-flex items-center gap-1 text-xs text-ink-500">
          <Clock className="h-3 w-3" />
          {formatEta(cart.eta_minutes)}
        </div>
      </div>

      <ul className="divide-y divide-ink-100 px-4">
        {cart.lines.map((line) => {
          const mods = Object.values(line.selected_modifiers ?? {}).filter(
            Boolean
          );
          return (
            <li key={line.item_id} className="flex items-start gap-3 py-3">
              <div className="shrink-0 rounded-md bg-ink-100 px-2 py-0.5 text-xs font-semibold text-ink-700">
                ×{line.quantity}
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-ink-900">
                  {line.name}
                </div>
                {mods.length > 0 && (
                  <div className="mt-0.5 text-xs text-ink-500">
                    {mods.join(" · ")}
                  </div>
                )}
                {line.notes && (
                  <div className="mt-0.5 text-xs italic text-ink-400">
                    Note: {line.notes}
                  </div>
                )}
              </div>
              <div className="shrink-0 text-sm font-semibold text-ink-900">
                {formatPrice(line.unit_price_cents * line.quantity)}
              </div>
            </li>
          );
        })}
      </ul>

      <dl className="space-y-1 border-t border-ink-100 px-4 py-3 text-sm">
        <TotalRow label="Subtotal" value={cart.subtotal_cents} />
        <TotalRow label="Delivery" value={cart.delivery_fee_cents} />
        <TotalRow label="Service" value={cart.service_fee_cents} />
        <TotalRow label="Tax" value={cart.tax_cents} />
        <div className="mt-1 flex items-center justify-between border-t border-ink-100 pt-2 text-base font-semibold text-ink-900">
          <span>Total</span>
          <span>{formatPrice(cart.total_cents)}</span>
        </div>
      </dl>

      <div className="flex gap-2 border-t border-ink-100 p-3">
        <button
          type="button"
          onClick={onCancel}
          className="flex-1 rounded-full border border-ink-200 bg-white px-4 py-2.5 text-sm font-medium text-ink-700 transition hover:border-ink-300 hover:bg-ink-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className="flex-[2] rounded-full bg-lumo-500 px-4 py-2.5 text-sm font-semibold text-white shadow-soft transition hover:bg-lumo-600 active:bg-lumo-700"
        >
          Confirm · {formatPrice(cart.total_cents)}
        </button>
      </div>
    </div>
  );
}

function TotalRow({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center justify-between text-ink-600">
      <dt>{label}</dt>
      <dd className="tabular-nums">{formatPrice(value)}</dd>
    </div>
  );
}

// -------------------------------------------------------------------------
// Order confirmation — the celebratory "we got it" card
// -------------------------------------------------------------------------

function OrderConfirmation({ order }: { order: Order }) {
  return (
    <div className="animate-slide-up overflow-hidden rounded-2xl border border-emerald-100 bg-gradient-to-br from-emerald-50 to-white shadow-card">
      <div className="flex items-center gap-3 px-4 pt-4">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-500 text-white shadow-soft">
          <Check className="h-5 w-5" />
        </div>
        <div>
          <div className="text-[15px] font-semibold text-ink-900">
            Order placed
          </div>
          <div className="text-xs text-ink-500">
            #{order.id} · {order.cart.restaurant_name}
          </div>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 px-4">
        <Stat
          icon={<Truck className="h-4 w-4 text-emerald-600" />}
          label="ETA"
          value={formatEta(order.cart.eta_minutes)}
        />
        <Stat
          icon={<ShoppingBag className="h-4 w-4 text-emerald-600" />}
          label="Total"
          value={formatPrice(order.cart.total_cents)}
        />
      </div>

      <div className="mt-3 border-t border-emerald-100 bg-white/60 px-4 py-2.5 text-xs text-ink-500">
        Heading to{" "}
        <span className="font-medium text-ink-700">{order.address}</span>
      </div>
    </div>
  );
}

function Stat({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-xl bg-white/80 px-3 py-2 ring-1 ring-emerald-100">
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-ink-500">
        {icon}
        {label}
      </div>
      <div className="mt-0.5 text-sm font-semibold text-ink-900">{value}</div>
    </div>
  );
}

// -------------------------------------------------------------------------
// Order status (for a "where's my food" lookup)
// -------------------------------------------------------------------------

function OrderStatusCard({ order }: { order: Order }) {
  const steps: Array<Order["status"]> = [
    "placed",
    "preparing",
    "out_for_delivery",
    "delivered",
  ];
  const currentIdx = Math.max(0, steps.indexOf(order.status));
  const label: Record<Order["status"], string> = {
    placed: "Placed",
    preparing: "Preparing",
    out_for_delivery: "On the way",
    delivered: "Delivered",
    cancelled: "Cancelled",
  };

  return (
    <div className="animate-fade-in rounded-2xl border border-ink-100 bg-white p-4 shadow-card">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[13px] font-semibold text-ink-900">
            {order.cart.restaurant_name}
          </div>
          <div className="text-xs text-ink-500">#{order.id}</div>
        </div>
        <div className="rounded-full bg-lumo-50 px-3 py-1 text-xs font-medium text-lumo-700 ring-1 ring-lumo-100">
          {label[order.status]}
        </div>
      </div>

      {order.status !== "cancelled" && (
        <ol className="mt-4 flex items-center">
          {steps.map((step, i) => {
            const done = i <= currentIdx;
            return (
              <li key={step} className="flex flex-1 items-center last:flex-none">
                <div
                  className={cn(
                    "flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-bold",
                    done
                      ? "bg-lumo-500 text-white"
                      : "bg-ink-100 text-ink-400"
                  )}
                >
                  {done ? <Check className="h-3 w-3" /> : i + 1}
                </div>
                {i < steps.length - 1 && (
                  <div
                    className={cn(
                      "mx-1 h-0.5 flex-1 rounded",
                      i < currentIdx ? "bg-lumo-500" : "bg-ink-100"
                    )}
                  />
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

// -------------------------------------------------------------------------
// Order history (compact list with a "reorder" tap)
// -------------------------------------------------------------------------

function OrderHistory({
  orders,
  onReorder,
}: {
  orders: Order[];
  onReorder: (text: string) => void;
}) {
  if (orders.length === 0) {
    return (
      <InfoCard
        icon={<Clock className="h-4 w-4" />}
        title="No recent orders"
        body="Once you order, I'll remember it here so you can reorder in one tap."
      />
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {orders.map((order) => (
        <button
          key={order.id}
          type="button"
          onClick={() =>
            onReorder(`Reorder my ${order.cart.restaurant_name} order.`)
          }
          className="animate-fade-in flex w-full items-center gap-3 rounded-2xl border border-ink-100 bg-white p-3 text-left shadow-card transition hover:border-lumo-200 hover:shadow-soft"
        >
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-ink-50 text-ink-600">
            <ShoppingBag className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-ink-900">
              {order.cart.restaurant_name}
            </div>
            <div className="truncate text-xs text-ink-500">
              {order.cart.lines
                .map((l) => `${l.quantity}× ${l.name}`)
                .join(", ")}
            </div>
          </div>
          <div className="shrink-0 text-right">
            <div className="text-sm font-semibold text-ink-900">
              {formatPrice(order.cart.total_cents)}
            </div>
            <div className="text-[11px] text-lumo-600">Reorder</div>
          </div>
        </button>
      ))}
    </div>
  );
}

// -------------------------------------------------------------------------
// Generic info / error card
// -------------------------------------------------------------------------

function InfoCard({
  icon,
  title,
  body,
  tone = "neutral",
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  tone?: "neutral" | "error";
}) {
  return (
    <div
      className={cn(
        "animate-fade-in flex items-start gap-3 rounded-2xl border p-3 shadow-card",
        tone === "error"
          ? "border-red-100 bg-red-50"
          : "border-ink-100 bg-white"
      )}
    >
      <div
        className={cn(
          "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
          tone === "error"
            ? "bg-red-100 text-red-600"
            : "bg-ink-50 text-ink-500"
        )}
      >
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div
          className={cn(
            "text-sm font-semibold",
            tone === "error" ? "text-red-700" : "text-ink-900"
          )}
        >
          {title}
        </div>
        <div
          className={cn(
            "mt-0.5 text-xs",
            tone === "error" ? "text-red-600" : "text-ink-500"
          )}
        >
          {body}
        </div>
      </div>
    </div>
  );
}
