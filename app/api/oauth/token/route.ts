/**
 * POST /api/oauth/token
 *
 * OAuth 2.1 token endpoint for the Food Agent. Handles two grant types:
 *
 *   grant_type=authorization_code  — first-time token issuance. Body:
 *     code, redirect_uri, code_verifier, client_id, [client_secret]
 *
 *   grant_type=refresh_token       — renew an access token. Body:
 *     refresh_token, client_id, [client_secret]
 *
 * Response is the OAuth 2.0-standard JSON envelope:
 *   { access_token, token_type: "Bearer", expires_in, refresh_token, scope }
 *
 * RFC 6749 §4.1.3 + §6. Errors use the standard error codes per §5.2.
 *
 * Per MVP spec we support a single relying party (the Super Agent). The
 * client_id/secret are checked via isKnownClient.
 */

import { NextResponse } from "next/server";
import {
  exchangeCodeForTokens,
  isKnownClient,
  OAuthError,
  refreshAccessToken,
} from "@/lib/oauth-provider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  // Token endpoint accepts application/x-www-form-urlencoded (RFC 6749
  // §4.1.3) and JSON (pragmatic).
  let form: Record<string, string>;
  try {
    const ct = req.headers.get("content-type") ?? "";
    if (ct.includes("application/x-www-form-urlencoded")) {
      const body = await req.text();
      const params = new URLSearchParams(body);
      form = Object.fromEntries(params);
    } else {
      form = (await req.json()) as Record<string, string>;
    }
  } catch {
    return oauthError("invalid_request", "Unparseable request body.", 400);
  }

  const grant_type = form.grant_type;

  // Client auth can arrive as Basic header OR in the body. We support both.
  let client_id = form.client_id;
  let client_secret = form.client_secret;
  const basic = req.headers.get("authorization");
  if (basic?.startsWith("Basic ")) {
    try {
      const [id, secret] = Buffer.from(basic.slice("Basic ".length), "base64")
        .toString("utf8")
        .split(":");
      if (id) client_id = id;
      if (secret) client_secret = secret;
    } catch {
      // fall through
    }
  }

  if (!client_id) {
    return oauthError("invalid_client", "client_id is required.", 401);
  }
  if (!isKnownClient(client_id, client_secret)) {
    return oauthError("invalid_client", "Unknown client_id or bad client_secret.", 401);
  }

  try {
    if (grant_type === "authorization_code") {
      const { code, redirect_uri, code_verifier } = form;
      if (!code || !redirect_uri || !code_verifier) {
        return oauthError(
          "invalid_request",
          "code, redirect_uri, and code_verifier are required.",
          400,
        );
      }
      const tokens = exchangeCodeForTokens({
        code,
        redirect_uri,
        code_verifier,
        client_id,
      });
      return NextResponse.json(tokens, {
        status: 200,
        headers: { "cache-control": "no-store" },
      });
    }

    if (grant_type === "refresh_token") {
      const { refresh_token } = form;
      if (!refresh_token) {
        return oauthError("invalid_request", "refresh_token is required.", 400);
      }
      const tokens = refreshAccessToken({ refresh_token, client_id });
      return NextResponse.json(tokens, {
        status: 200,
        headers: { "cache-control": "no-store" },
      });
    }

    return oauthError(
      "unsupported_grant_type",
      `Grant type '${grant_type}' is not supported.`,
      400,
    );
  } catch (err) {
    if (err instanceof OAuthError) {
      const status = err.code === "invalid_client" ? 401 : 400;
      return oauthError(err.code, err.message, status);
    }
    console.error("[oauth/token] unexpected error:", err);
    return oauthError("server_error", "Token endpoint internal error.", 500);
  }
}

function oauthError(code: string, description: string, status: number): Response {
  return new Response(
    JSON.stringify({ error: code, error_description: description }),
    {
      status,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
      },
    },
  );
}
