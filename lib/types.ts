/**
 * Domain types shared across the backend, the web UI, and the mobile app.
 * Keep these flat and serializable — they travel over the wire.
 */

export type Cuisine =
  | "pizza"
  | "mexican"
  | "indian"
  | "thai"
  | "chinese"
  | "american"
  | "japanese"
  | "mediterranean"
  | "breakfast"
  | "dessert";

export interface Restaurant {
  id: string;
  name: string;
  cuisine: Cuisine[];
  rating: number;
  review_count: number;
  price_level: 1 | 2 | 3 | 4;
  distance_miles: number;
  eta_minutes: number;
  is_open: boolean;
  tags: string[];
}

export interface MenuItem {
  id: string;
  restaurant_id: string;
  name: string;
  description: string;
  price_cents: number;
  category: string;
  modifiers?: Array<{
    name: string;
    options: Array<{ label: string; delta_cents: number }>;
    default?: string;
  }>;
}

export interface CartLine {
  item_id: string;
  name: string;
  quantity: number;
  unit_price_cents: number;
  selected_modifiers: Record<string, string>;
  notes?: string;
}

export interface Cart {
  restaurant_id: string;
  restaurant_name: string;
  lines: CartLine[];
  subtotal_cents: number;
  delivery_fee_cents: number;
  service_fee_cents: number;
  tax_cents: number;
  total_cents: number;
  eta_minutes: number;
}

export interface Order {
  id: string;
  cart: Cart;
  address: string;
  placed_at: string;
  status: "placed" | "preparing" | "out_for_delivery" | "delivered" | "cancelled";
  estimated_delivery_at: string;
  /** Stripe PaymentIntent id when Stripe is configured; omitted in the demo cash flow. */
  payment_intent_id?: string;
}

/** Per-session snapshot of the current Stripe PaymentIntent. */
export interface PaymentIntentRecord {
  payment_intent_id: string;
  client_secret: string;
  amount_cents: number;
  status: string;
}
