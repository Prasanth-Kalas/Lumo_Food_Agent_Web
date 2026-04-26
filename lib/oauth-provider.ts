/**
 * Minimal OAuth 2.1 Authorization Server for the Food Agent.
 *
 * Scope: MVP — single relying-party (the Lumo Super Agent). Authorization
 * Code + PKCE. Confidential client (client_id + client_secret). In
 * production/serverless, grants and tokens are signed self-contained
 * envelopes so the authorization and token endpoints can run on different
 * Vercel instances. In local dev without a signing secret, we keep the
 * original process-local maps for convenience.
 *
 * This file implements:
 *
 *   mintAuthorizeGrant({ client_id, redirect_uri, scope, state,
 *                        code_challenge, code_challenge_method, user })
 *     → returns a short-lived `code` the client redirects back with
 *
 *   exchangeCodeForTokens({ code, code_verifier, redirect_uri,
 *                           client_id, client_secret })
 *     → verifies PKCE, returns { access_token, refresh_token, expires_in, scope }
 *
 *   refreshAccessToken({ refresh_token, client_id, client_secret })
 *     → returns a new access_token (and optionally rotated refresh_token)
 *
 *   resolveBearer(access_token)
 *     → { user_id, scopes } or null
 *
 * Not implemented (intentionally): dynamic client registration, consent
 * revocation flows, token introspection endpoint. These are Phase 3+
 * work for the publisher portal.
 *
 * Fraud/abuse: authorize codes expire after 60s and are single-use.
 * Access tokens live 1 hour; refresh tokens are long-lived but rotate
 * on each use (mitigates leaked-refresh-token replay).
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// ──────────────────────────────────────────────────────────────────────────
// In-memory stores. Process-local. Survive only until restart.
// ──────────────────────────────────────────────────────────────────────────

interface AuthorizeGrant {
  code: string;
  client_id: string;
  redirect_uri: string;
  scope: string;
  code_challenge: string;
  code_challenge_method: "S256";
  user_id: string;
  expires_at: number;
}

interface AccessToken {
  token: string;
  user_id: string;
  scopes: string[];
  expires_at: number;
}

interface RefreshToken {
  token: string;
  user_id: string;
  scopes: string[];
  client_id: string;
}

const grants = new Map<string, AuthorizeGrant>();
const accessTokens = new Map<string, AccessToken>();
const refreshTokens = new Map<string, RefreshToken>();

const GRANT_TTL_MS = 60 * 1000;
const ACCESS_TTL_SEC = 60 * 60;
const REFRESH_TTL_SEC = 60 * 60 * 24 * 30;

// ──────────────────────────────────────────────────────────────────────────
// Client credential check
// ──────────────────────────────────────────────────────────────────────────

/**
 * Validate the client_id (and optional client_secret) on the token
 * endpoint. In MVP we support a single relying party — the Super Agent —
 * whose credentials come from env.
 */
export function isKnownClient(
  client_id: string,
  client_secret: string | undefined,
): boolean {
  const expectedId = process.env.LUMO_SUPER_AGENT_CLIENT_ID ?? "lumo-super-agent";
  const expectedSecret = process.env.LUMO_SUPER_AGENT_CLIENT_SECRET; // optional
  if (client_id !== expectedId) return false;
  if (expectedSecret && client_secret !== expectedSecret) return false;
  return true;
}

// ──────────────────────────────────────────────────────────────────────────
// Authorize grant
// ──────────────────────────────────────────────────────────────────────────

export function mintAuthorizeGrant(args: {
  client_id: string;
  redirect_uri: string;
  scope: string;
  code_challenge: string;
  code_challenge_method: string;
  user_id: string;
}): { code: string } {
  if (args.code_challenge_method !== "S256") {
    throw new Error("Only S256 PKCE is supported.");
  }
  if (hasSigningSecret()) {
    return {
      code: signEnvelope("fc", {
        typ: "grant",
        client_id: args.client_id,
        redirect_uri: args.redirect_uri,
        scope: args.scope,
        code_challenge: args.code_challenge,
        code_challenge_method: "S256",
        user_id: args.user_id,
        exp: nowSeconds() + Math.floor(GRANT_TTL_MS / 1000),
      }),
    };
  }
  const code = urlSafeRandom(32);
  grants.set(code, {
    code,
    client_id: args.client_id,
    redirect_uri: args.redirect_uri,
    scope: args.scope,
    code_challenge: args.code_challenge,
    code_challenge_method: "S256",
    user_id: args.user_id,
    expires_at: Date.now() + GRANT_TTL_MS,
  });
  return { code };
}

// ──────────────────────────────────────────────────────────────────────────
// Token endpoint backends
// ──────────────────────────────────────────────────────────────────────────

export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

export function exchangeCodeForTokens(args: {
  code: string;
  code_verifier: string;
  redirect_uri: string;
  client_id: string;
}): TokenResponse {
  const signedGrant = verifyEnvelope<SignedGrantPayload>(args.code, "fc", "grant");
  const grant = signedGrant
    ? {
        code: args.code,
        client_id: signedGrant.client_id,
        redirect_uri: signedGrant.redirect_uri,
        scope: signedGrant.scope,
        code_challenge: signedGrant.code_challenge,
        code_challenge_method: signedGrant.code_challenge_method,
        user_id: signedGrant.user_id,
        expires_at: signedGrant.exp * 1000,
      }
    : grants.get(args.code);
  if (!grant) throw new OAuthError("invalid_grant", "Unknown or expired code.");
  // Single-use.
  if (!signedGrant) grants.delete(args.code);
  if (grant.expires_at < Date.now()) {
    throw new OAuthError("invalid_grant", "Authorization code expired.");
  }
  if (grant.client_id !== args.client_id) {
    throw new OAuthError("invalid_grant", "Code/client mismatch.");
  }
  if (grant.redirect_uri !== args.redirect_uri) {
    throw new OAuthError("invalid_grant", "redirect_uri mismatch.");
  }
  // PKCE verify.
  const computed = base64urlSha256(args.code_verifier);
  if (computed !== grant.code_challenge) {
    throw new OAuthError("invalid_grant", "PKCE verifier does not match challenge.");
  }

  return issueTokens({
    user_id: grant.user_id,
    scopes: grant.scope.split(/\s+/).filter(Boolean),
    client_id: grant.client_id,
  });
}

export function refreshAccessToken(args: {
  refresh_token: string;
  client_id: string;
}): TokenResponse {
  const signedRefresh = verifyEnvelope<SignedRefreshPayload>(
    args.refresh_token,
    "fr",
    "refresh",
  );
  if (signedRefresh) {
    if (signedRefresh.client_id !== args.client_id) {
      throw new OAuthError("invalid_grant", "Refresh token does not belong to this client.");
    }
    return issueTokens({
      user_id: signedRefresh.user_id,
      scopes: signedRefresh.scopes,
      client_id: signedRefresh.client_id,
    });
  }

  const rt = refreshTokens.get(args.refresh_token);
  if (!rt) throw new OAuthError("invalid_grant", "Unknown refresh token.");
  if (rt.client_id !== args.client_id) {
    throw new OAuthError("invalid_grant", "Refresh token does not belong to this client.");
  }
  // Rotate: invalidate the old refresh token, mint new ones.
  refreshTokens.delete(args.refresh_token);
  return issueTokens({ user_id: rt.user_id, scopes: rt.scopes, client_id: rt.client_id });
}

function issueTokens(args: {
  user_id: string;
  scopes: string[];
  client_id: string;
}): TokenResponse {
  if (hasSigningSecret()) {
    const now = nowSeconds();
    return {
      access_token: signEnvelope("fa", {
        typ: "access",
        user_id: args.user_id,
        scopes: args.scopes,
        exp: now + ACCESS_TTL_SEC,
      }),
      token_type: "Bearer",
      expires_in: ACCESS_TTL_SEC,
      refresh_token: signEnvelope("fr", {
        typ: "refresh",
        user_id: args.user_id,
        scopes: args.scopes,
        client_id: args.client_id,
        exp: now + REFRESH_TTL_SEC,
      }),
      scope: args.scopes.join(" "),
    };
  }

  const access_token = `fa_${urlSafeRandom(32)}`;
  const refresh_token = `fr_${urlSafeRandom(32)}`;
  const expires_at = Math.floor(Date.now() / 1000) + ACCESS_TTL_SEC;

  accessTokens.set(access_token, {
    token: access_token,
    user_id: args.user_id,
    scopes: args.scopes,
    expires_at,
  });
  refreshTokens.set(refresh_token, {
    token: refresh_token,
    user_id: args.user_id,
    scopes: args.scopes,
    client_id: args.client_id,
  });

  return {
    access_token,
    token_type: "Bearer",
    expires_in: ACCESS_TTL_SEC,
    refresh_token,
    scope: args.scopes.join(" "),
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Bearer validation — tool routes call this to authorize a request
// ──────────────────────────────────────────────────────────────────────────

export function resolveBearer(
  token: string,
): { user_id: string; scopes: string[] } | null {
  const signedAccess = verifyEnvelope<SignedAccessPayload>(token, "fa", "access");
  if (signedAccess) {
    return { user_id: signedAccess.user_id, scopes: signedAccess.scopes };
  }

  const row = accessTokens.get(token);
  if (!row) return null;
  if (row.expires_at * 1000 < Date.now()) {
    accessTokens.delete(token);
    return null;
  }
  return { user_id: row.user_id, scopes: row.scopes };
}

// ──────────────────────────────────────────────────────────────────────────
// Errors + helpers
// ──────────────────────────────────────────────────────────────────────────

export class OAuthError extends Error {
  readonly code:
    | "invalid_request"
    | "invalid_grant"
    | "invalid_client"
    | "unsupported_grant_type"
    | "server_error";
  constructor(code: OAuthError["code"], message: string) {
    super(message);
    this.name = "OAuthError";
    this.code = code;
  }
}

interface SignedGrantPayload extends SignedPayload {
  typ: "grant";
  client_id: string;
  redirect_uri: string;
  scope: string;
  code_challenge: string;
  code_challenge_method: "S256";
  user_id: string;
}

interface SignedAccessPayload extends SignedPayload {
  typ: "access";
  user_id: string;
  scopes: string[];
}

interface SignedRefreshPayload extends SignedPayload {
  typ: "refresh";
  user_id: string;
  scopes: string[];
  client_id: string;
}

interface SignedPayload {
  typ: string;
  exp: number;
}

function hasSigningSecret(): boolean {
  return signingSecret().length >= 32;
}

function signingSecret(): string {
  return (
    process.env.LUMO_FOOD_OAUTH_SIGNING_SECRET ??
    process.env.LUMO_SUPER_AGENT_CLIENT_SECRET ??
    ""
  ).trim();
}

function signEnvelope(prefix: "fc" | "fa" | "fr", payload: Record<string, unknown>): string {
  const body = base64urlEncode(JSON.stringify(payload));
  const sig = hmac(body);
  return `${prefix}_${body}.${sig}`;
}

function verifyEnvelope<T extends SignedPayload>(
  token: string,
  prefix: "fc" | "fa" | "fr",
  typ: T["typ"],
): T | null {
  if (!hasSigningSecret()) return null;
  const start = `${prefix}_`;
  if (!token.startsWith(start)) return null;
  const rest = token.slice(start.length);
  const dot = rest.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = rest.slice(0, dot);
  const sig = rest.slice(dot + 1);
  if (!safeEqual(sig, hmac(body))) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(base64urlDecode(body));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object") return null;
  const row = payload as Partial<T>;
  if (row.typ !== typ) return null;
  if (typeof row.exp !== "number" || row.exp < nowSeconds()) return null;
  return row as T;
}

function hmac(body: string): string {
  return createHmac("sha256", signingSecret()).update(body).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function urlSafeRandom(bytes: number): string {
  return randomBytes(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64urlEncode(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

function base64urlDecode(input: string): string {
  return Buffer.from(input, "base64url").toString("utf8");
}

function base64urlSha256(input: string): string {
  return createHash("sha256")
    .update(input)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
