# Lumo — order food by chat

A chat-first food ordering agent for the US market, starting in **Austin, TX**.
The user talks to the agent in natural language ("I want Thai food tonight") and
the agent resolves the restaurant, builds the cart, reviews it, and places the
order — all in one thread.

Built by **Lumo Technologies, Inc.** (Delaware).

---

## What's in this repo

This is the **web MVP** — a Next.js 14 App Router app with streaming tool calling
against Claude Sonnet. It's ready to demo end-to-end with mock restaurant data,
so you don't need MealMe keys on day one.

```
lumo-food-agent/
├── app/
│   ├── api/chat/route.ts     # Streaming agent endpoint (Vercel AI SDK)
│   ├── globals.css           # Tailwind + chat-specific polish
│   ├── layout.tsx            # PWA metadata, viewport, fonts
│   └── page.tsx              # Chat UI (useChat, suggestions, composer)
├── components/
│   ├── MessageBubble.tsx     # User/assistant speech bubbles
│   └── ToolResultRenderer.tsx# Restaurant cards, cart, order confirmation
├── lib/
│   ├── system-prompt.ts      # The agent's brain (rules, tone, guardrails)
│   ├── tools.ts              # 7 tools: search → menu → cart → confirm → order
│   ├── mock-data.ts          # 10 Austin restaurants + full menus
│   ├── types.ts              # Cart / Order / Restaurant shapes
│   └── utils.ts              # cn(), formatPrice(), formatEta()
├── public/
│   ├── manifest.json         # Installable PWA
│   └── icon.svg              # App icon (works for iOS/Android home screen)
├── .env.example
└── README.md                 # You are here
```

The mobile app lives in a sibling folder: `lumo-food-agent-mobile/` (Expo React
Native). See **Mobile app** below.

---

## The agent, in one paragraph

Claude Sonnet 4.6 runs in a `streamText` loop with 7 tools. When the user says
"large pepperoni from the closest Domino's," the model calls
`search_restaurants` → picks the nearest open match → calls
`get_restaurant_menu` → calls `build_cart` with the right item and modifiers →
calls `get_cart_summary` → asks the user "Confirm?" → waits for an explicit
keyword (yes / confirm / place it / go ahead) → calls `place_order`.

Confirmation is gated in **both** the system prompt and the tool's
`execute()` — the tool refuses to place an order unless `user_confirmed=true`,
a `confirmation_phrase` was quoted, and the cart summary was shown in the last
60 seconds. Defense in depth against LLMs that occasionally skip instructions.

---

## Run it locally

Prereqs: Node 18.18+ and an Anthropic API key.

```bash
cd lumo-food-agent
npm install
cp .env.example .env.local
# edit .env.local — paste your ANTHROPIC_API_KEY
npm run dev
```

Open <http://localhost:3000>. Try a suggestion chip, or type:

- "Order a large pepperoni pizza"
- "I want Thai food tonight"
- "Breakfast tacos, fast"
- "Something vegetarian, under $20"

Everything runs against `lib/mock-data.ts` — no MealMe keys needed.

### Env vars

| Name | Required | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | yes | From console.anthropic.com |
| `ANTHROPIC_MODEL` | no | Defaults to `claude-sonnet-4-6` |
| `SERVICE_CITY` | no | Defaults to `Austin, TX`. The agent politely declines orders outside this. |

---

## Deploy (Vercel, free tier)

1. Push this folder to a new GitHub repo.
2. Import it at <https://vercel.com/new>.
3. Set `ANTHROPIC_API_KEY` in the project's Environment Variables.
4. Deploy. Share the `*.vercel.app` URL with your 50 test friends.

The `/api/chat` route streams — Vercel's Node runtime handles that out of the
box. We've set `maxDuration: 60` in the route for long tool chains.

### Add it to the home screen (PWA)

- **iOS Safari:** Share → Add to Home Screen → "Lumo"
- **Android Chrome:** menu → Install app

`public/manifest.json` + the iOS meta tags in `app/layout.tsx` make it behave
like a native app (standalone display, themed status bar).

---

## Going from mock data to real merchants

The mock layer in `lib/mock-data.ts` exposes the **exact same shape** the real
integration will return. To swap in MealMe:

1. `npm i mealme-sdk` (or call their REST directly)
2. Create `lib/mealme.ts` with `searchRestaurants()`, `getMenu()`, `placeOrder()`
3. In `lib/tools.ts`, replace the `...Mock` imports with the real ones
4. Add `MEALME_API_KEY` to `.env.local`

Tier 2 (restaurants with their own online ordering) and Tier 3 (phone-only
long-tail — AI voice agent via Twilio + Retell/Vapi) plug in the same way:
add a new function that matches the mock interface, route to it based on
`restaurant.integration_type`. The UI doesn't need to change.

---

## Mobile app

The Expo React Native client lives in the sibling folder
`lumo-food-agent-mobile/`. It talks to this same `/api/chat` endpoint, so the
agent logic only lives in one place.

```bash
cd ../lumo-food-agent-mobile
npm install
cp .env.example .env
# set EXPO_PUBLIC_API_BASE_URL to your deployed Vercel URL
npx expo start
```

For iOS TestFlight / Android internal testing use EAS:

```bash
npm i -g eas-cli
eas login
eas build --profile preview --platform ios     # TestFlight build
eas build --profile preview --platform android # .apk for direct install
```

See `lumo-food-agent-mobile/README.md` for the full mobile setup.

---

## What's intentionally missing (for now)

- **Real payments.** The MVP places mock orders. For production, wire Stripe
  Checkout on the web and Apple/Google Pay on mobile, and issue virtual cards
  (Stripe Issuing) for Tier 3 phone orders.
- **Auth.** Everything is pinned to session `"demo"`. Add Clerk/Supabase Auth
  once you're past the 50-friend test.
- **Persistence.** `sessionCarts` and `sessionOrders` are module-level Maps.
  They'll reset on deploy. Swap in Upstash Redis or Vercel Postgres when real
  users show up.
- **Voice.** The mic button is in the UI but disabled. v1.5 adds push-to-talk
  via Deepgram (STT) + ElevenLabs (TTS), same agent loop underneath.
- **Delivery.** The ETA is mocked. Production wires Uber Direct or DoorDash
  Drive for last-mile.

Every one of these is a single-file change because the interfaces are stable.

---

## Guardrails already in place

- **Confirmation gate** — `place_order` refuses without an explicit user
  confirmation word AND a recent cart summary. Enforced in code, not just the
  system prompt.
- **Service-area lock** — `SERVICE_CITY` env var interpolates into the system
  prompt; the agent declines orders outside Austin with a clear message.
- **Substitution rules** — if a requested item is unavailable, the agent must
  propose a specific substitute and wait for approval before rebuilding the
  cart.
- **No hallucinated restaurants** — the agent can only recommend from tool
  results. The system prompt is explicit on this.

---

## Cost & infra (the $100 budget)

- Vercel hobby: **$0**
- Anthropic API: pay-as-you-go; ~$0.01–0.04 per full order conversation
- Domain (optional): **$12/yr**
- 50 friends × ~5 orders each × $0.03 ≈ **$7.50** for the whole beta

Room to spare for Twilio test numbers when Tier 3 lands.

---

## License

All rights reserved · Lumo Technologies, Inc.
