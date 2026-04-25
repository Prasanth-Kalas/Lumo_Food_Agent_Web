/**
 * GET /oauth/authorize
 *
 * The Food Agent's consent screen. The Super Agent redirects the user
 * here with:
 *   ?response_type=code
 *   &client_id=lumo-super-agent
 *   &redirect_uri=https://super.lumo.rentals/api/connections/callback
 *   &scope=food:read food:orders
 *   &state=<opaque>
 *   &code_challenge=<S256>
 *   &code_challenge_method=S256
 *
 * For MVP, we're a single-tenant pseudo-provider: there's no login UI
 * here yet. We auto-attach the user's Food Agent identity by asking for
 * an email (or picking one from a dev cookie in dev). In prod this page
 * would be behind the Food Agent's actual login.
 *
 * On Allow → POST /oauth/authorize/complete (server action below) which
 * mints a grant and redirects to redirect_uri?code=…&state=…
 *
 * On Deny → redirect to redirect_uri?error=access_denied&state=…
 */

import { redirect } from "next/navigation";
import { mintAuthorizeGrant, OAuthError } from "@/lib/oauth-provider";

interface PageProps {
  searchParams: Record<string, string | string[] | undefined>;
}

export default function AuthorizePage({ searchParams }: PageProps) {
  const params = normalize(searchParams);

  // Validate minimum required inputs up-front so we don't render a form
  // for a request we already know we'll reject.
  const required = [
    "response_type",
    "client_id",
    "redirect_uri",
    "scope",
    "state",
    "code_challenge",
    "code_challenge_method",
  ] as const;
  for (const k of required) {
    if (!params[k]) {
      return renderError(`Missing ${k}`);
    }
  }
  if (params.response_type !== "code") {
    return renderError("response_type must be 'code'");
  }
  if (params.code_challenge_method !== "S256") {
    return renderError("Only S256 PKCE is supported");
  }

  // Server Actions closing over `params`. We required every field up
  // top so the non-null assertions here are safe; the validator above
  // has already short-circuited if anything was missing.
  const redirect_uri = params.redirect_uri!;
  const state = params.state!;
  const client_id = params.client_id!;
  const scope = params.scope!;
  const code_challenge = params.code_challenge!;
  const code_challenge_method = params.code_challenge_method as "S256";

  async function onAllow(formData: FormData) {
    "use server";
    const email = String(formData.get("email") ?? "").trim();
    if (!email) {
      // In a real provider we'd re-render with an error. For MVP we
      // bounce back to the Super Agent with access_denied.
      redirect(buildDenyUrl(redirect_uri, state));
    }

    try {
      const { code } = mintAuthorizeGrant({
        client_id,
        redirect_uri,
        scope,
        code_challenge,
        code_challenge_method,
        // For MVP we use the submitted email as the Food Agent's notion
        // of a user. Prod would look this up in the Food Agent's own
        // users table (or SSO back to Lumo-ID if we go that route).
        user_id: `food-user:${email.toLowerCase()}`,
      });
      redirect(buildSuccessUrl(redirect_uri, state, code));
    } catch (err) {
      if (err instanceof OAuthError) {
        redirect(buildDenyUrl(redirect_uri, state, err.code));
      }
      throw err;
    }
  }

  async function onDeny() {
    "use server";
    redirect(buildDenyUrl(redirect_uri, state));
  }

  const scopes = (params.scope ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .map(describeScope);

  return (
    <main style={mainStyle}>
      <div style={cardStyle}>
        <div style={{ marginBottom: 16, display: "flex", alignItems: "center", gap: 10 }}>
          <div style={logoStyle}>🍱</div>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600 }}>Lumo Food</div>
            <div style={{ fontSize: 12, color: "#888" }}>Connect to your Lumo assistant</div>
          </div>
        </div>

        <h1 style={{ fontSize: 20, fontWeight: 700, margin: "12px 0 6px" }}>
          Allow Lumo to use Lumo Food on your behalf?
        </h1>
        <p style={{ fontSize: 13, color: "#555", margin: "0 0 14px" }}>
          Once connected, Lumo can search restaurants, price carts, and place orders when you ask it to.
        </p>

        <ul style={{ fontSize: 13, color: "#333", padding: "0 0 0 18px", margin: "0 0 16px" }}>
          {scopes.map((s) => (
            <li key={s} style={{ marginBottom: 4 }}>{s}</li>
          ))}
        </ul>

        {/* Two forms side-by-side so the Deny button is a real server
            action, not a client-side document.createElement hack (which
            doesn't run in a Next 14 Server Component). */}
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <form action={onAllow} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <label style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: "#666" }}>
              Your Lumo Food email
              <input
                type="email"
                name="email"
                required
                placeholder="you@example.com"
                style={inputStyle}
              />
            </label>
            <button type="submit" style={primaryBtnStyle}>Allow</button>
          </form>

          <form action={onDeny}>
            <button type="submit" style={secondaryBtnStyle}>Deny</button>
          </form>
        </div>

        <p style={{ fontSize: 11, color: "#888", marginTop: 18 }}>
          You can disconnect Lumo Food at any time from your Lumo Connections page.
        </p>
      </div>
    </main>
  );
}

function renderError(message: string) {
  return (
    <main style={mainStyle}>
      <div style={cardStyle}>
        <h1 style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>Authorization error</h1>
        <p style={{ fontSize: 13, color: "#555" }}>{message}</p>
      </div>
    </main>
  );
}

function normalize(
  sp: Record<string, string | string[] | undefined>,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(sp)) {
    out[k] = Array.isArray(v) ? v[0] : v;
  }
  return out;
}

function buildSuccessUrl(redirect_uri: string, state: string, code: string): string {
  const u = new URL(redirect_uri);
  u.searchParams.set("code", code);
  u.searchParams.set("state", state);
  return u.toString();
}

function buildDenyUrl(redirect_uri: string, state: string, reason = "access_denied"): string {
  const u = new URL(redirect_uri);
  u.searchParams.set("error", reason);
  u.searchParams.set("state", state);
  return u.toString();
}

function describeScope(s: string): string {
  switch (s) {
    case "food:read":
      return "Browse restaurants and menus";
    case "food:orders":
      return "Place, track, and cancel food orders on your behalf";
    default:
      return s;
  }
}

// ── Styles ────────────────────────────────────────────────────────────────
const mainStyle: React.CSSProperties = {
  minHeight: "100dvh",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "#f6f6f3",
  padding: 16,
  fontFamily: "ui-sans-serif, system-ui, -apple-system, sans-serif",
};
const cardStyle: React.CSSProperties = {
  width: "100%",
  maxWidth: 400,
  background: "white",
  borderRadius: 12,
  boxShadow: "0 1px 3px rgba(0,0,0,0.08), 0 12px 32px rgba(0,0,0,0.08)",
  padding: 24,
};
const logoStyle: React.CSSProperties = {
  height: 36,
  width: 36,
  borderRadius: 8,
  background: "#fde68a",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 20,
};
const inputStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  marginTop: 6,
  padding: "9px 11px",
  fontSize: 14,
  border: "1px solid #e5e5e5",
  borderRadius: 6,
  background: "white",
  color: "#111",
};
const primaryBtnStyle: React.CSSProperties = {
  flex: 1,
  height: 36,
  background: "#111",
  color: "white",
  fontSize: 13,
  fontWeight: 600,
  border: "none",
  borderRadius: 6,
  cursor: "pointer",
};
const secondaryBtnStyle: React.CSSProperties = {
  flex: 1,
  height: 36,
  background: "transparent",
  color: "#555",
  fontSize: 13,
  border: "1px solid #e5e5e5",
  borderRadius: 6,
  cursor: "pointer",
};
