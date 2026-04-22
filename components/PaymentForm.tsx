"use client";

import {
  Elements,
  PaymentElement,
  useElements,
  useStripe,
} from "@stripe/react-stripe-js";
import { loadStripe, type Stripe as StripeJs } from "@stripe/stripe-js";
import { CreditCard, Loader2, ShieldCheck, XCircle } from "lucide-react";
import { useMemo, useState } from "react";
import { formatPrice } from "@/lib/utils";

/**
 * Stripe Elements card form, rendered inside the chat when the agent returns
 * a `payment_required` tool result.
 *
 * Flow:
 *   1. We memoize a stripePromise per publishable key (Stripe.js wants one
 *      Elements provider per key — caching avoids re-downloading their JS).
 *   2. <Elements> is configured with { clientSecret } so Stripe knows which
 *      PaymentIntent this form is for. No network call happens here; the
 *      secret is the auth token for the subsequent confirm call.
 *   3. On submit we call stripe.confirmPayment() with redirect: "if_required".
 *      For card-only flows that never redirects and we get the result inline.
 *   4. On success we fire onPaid() — the parent turns that into a chat
 *      message so the agent proceeds to place_order.
 *
 * We deliberately do NOT hit our backend directly on success: the
 * place_order tool re-checks the PI status via stripe.paymentIntents.retrieve
 * before committing, so client-side success is just a UX signal.
 */

type Props = {
  clientSecret: string;
  publishableKey: string | null;
  amountCents: number;
  onPaid: () => void;
};

export function PaymentForm(props: Props) {
  if (!props.publishableKey) {
    return (
      <div className="animate-fade-in flex items-start gap-3 rounded-2xl border border-red-100 bg-red-50 p-3 shadow-card">
        <XCircle className="h-4 w-4 shrink-0 text-red-600" />
        <div className="text-xs text-red-700">
          Stripe publishable key missing. Set{" "}
          <code className="rounded bg-red-100 px-1 py-0.5">
            NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
          </code>{" "}
          and redeploy.
        </div>
      </div>
    );
  }

  return (
    <PaymentFormInner
      clientSecret={props.clientSecret}
      publishableKey={props.publishableKey}
      amountCents={props.amountCents}
      onPaid={props.onPaid}
    />
  );
}

function PaymentFormInner({
  clientSecret,
  publishableKey,
  amountCents,
  onPaid,
}: Props & { publishableKey: string }) {
  // loadStripe is idempotent per key — memoize so re-renders don't re-fetch.
  const stripePromise = useMemo<Promise<StripeJs | null>>(
    () => loadStripe(publishableKey),
    [publishableKey]
  );

  return (
    <div className="animate-fade-in overflow-hidden rounded-2xl border border-ink-100 bg-white shadow-card">
      <div className="flex items-center gap-2 border-b border-ink-100 bg-ink-50 px-4 py-2.5">
        <CreditCard className="h-4 w-4 text-lumo-500" />
        <div className="flex-1 text-[13px] font-semibold text-ink-900">
          Payment
        </div>
        <div className="inline-flex items-center gap-1 text-xs text-ink-500">
          <ShieldCheck className="h-3 w-3" />
          Stripe · test mode
        </div>
      </div>

      <Elements
        stripe={stripePromise}
        options={{
          clientSecret,
          appearance: {
            theme: "flat",
            variables: {
              colorPrimary: "#f97316", // lumo-500
              colorText: "#0f172a",
              colorDanger: "#dc2626",
              fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
              borderRadius: "12px",
            },
          },
        }}
      >
        <CheckoutFields amountCents={amountCents} onPaid={onPaid} />
      </Elements>
    </div>
  );
}

function CheckoutFields({
  amountCents,
  onPaid,
}: {
  amountCents: number;
  onPaid: () => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [succeeded, setSucceeded] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!stripe || !elements || submitting) return;
    setSubmitting(true);
    setError(null);

    try {
      const { error: err, paymentIntent } = await stripe.confirmPayment({
        elements,
        // redirect: "if_required" keeps us inline for card flows; wallets
        // that need a redirect (e.g. Klarna) will bounce out and come back.
        redirect: "if_required",
      });

      if (err) {
        setError(err.message ?? "Payment failed. Try another card.");
        setSubmitting(false);
        return;
      }

      if (paymentIntent?.status === "succeeded") {
        setSucceeded(true);
        onPaid();
        return;
      }

      // Edge case: PI in a pending state we don't handle (e.g. processing).
      setError(
        `Payment status: ${paymentIntent?.status ?? "unknown"}. Give it a moment and retry, or try another card.`
      );
      setSubmitting(false);
    } catch (caught) {
      const msg =
        caught instanceof Error ? caught.message : "Unexpected error.";
      setError(msg);
      setSubmitting(false);
    }
  }

  if (succeeded) {
    return (
      <div className="flex items-start gap-3 px-4 py-4">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-white">
          <ShieldCheck className="h-4 w-4" />
        </div>
        <div>
          <div className="text-sm font-semibold text-ink-900">
            Payment confirmed
          </div>
          <div className="text-xs text-ink-500">
            Placing your order now…
          </div>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="px-4 py-4">
      <PaymentElement
        options={{
          layout: "tabs",
        }}
      />

      {error && (
        <div className="mt-3 flex items-start gap-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
          <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <button
        type="submit"
        disabled={!stripe || submitting}
        className="mt-4 flex w-full items-center justify-center gap-2 rounded-full bg-lumo-500 px-4 py-2.5 text-sm font-semibold text-white shadow-soft transition hover:bg-lumo-600 active:bg-lumo-700 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {submitting ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            Processing…
          </>
        ) : (
          <>Pay {formatPrice(amountCents)}</>
        )}
      </button>

      <div className="mt-2 text-center text-[11px] text-ink-400">
        Use test card{" "}
        <code className="rounded bg-ink-100 px-1 py-0.5 text-ink-600">
          4242 4242 4242 4242
        </code>{" "}
        · any future date · any CVC
      </div>
    </form>
  );
}
