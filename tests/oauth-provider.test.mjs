/**
 * Run: node --experimental-strip-types tests/oauth-provider.test.mjs
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";

process.env.LUMO_FOOD_OAUTH_SIGNING_SECRET =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const oauth = await import(`../lib/oauth-provider.ts?test=${Date.now()}`);

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ✗ ${name}\n    ${e.message}`);
  }
};

console.log("\nfood oauth provider");

t("stateless authorization code exchanges across serverless invocations", () => {
  const verifier = "verifier-123";
  const challenge = base64urlSha256(verifier);
  const { code } = oauth.mintAuthorizeGrant({
    client_id: "lumo-super-agent",
    redirect_uri: "https://lumo.example/api/connections/callback",
    scope: "food:read food:orders",
    code_challenge: challenge,
    code_challenge_method: "S256",
    user_id: "food-user:test@example.com",
  });

  assert.match(code, /^fc_/);
  const tokens = oauth.exchangeCodeForTokens({
    code,
    code_verifier: verifier,
    redirect_uri: "https://lumo.example/api/connections/callback",
    client_id: "lumo-super-agent",
  });

  assert.match(tokens.access_token, /^fa_/);
  assert.match(tokens.refresh_token, /^fr_/);
  assert.equal(tokens.scope, "food:read food:orders");
  assert.deepEqual(oauth.resolveBearer(tokens.access_token), {
    user_id: "food-user:test@example.com",
    scopes: ["food:read", "food:orders"],
  });
});

t("PKCE mismatch rejects the signed code", () => {
  const { code } = oauth.mintAuthorizeGrant({
    client_id: "lumo-super-agent",
    redirect_uri: "https://lumo.example/api/connections/callback",
    scope: "food:read",
    code_challenge: base64urlSha256("right-verifier"),
    code_challenge_method: "S256",
    user_id: "food-user:test@example.com",
  });

  assert.throws(
    () =>
      oauth.exchangeCodeForTokens({
        code,
        code_verifier: "wrong-verifier",
        redirect_uri: "https://lumo.example/api/connections/callback",
        client_id: "lumo-super-agent",
      }),
    /PKCE verifier does not match challenge/,
  );
});

t("signed refresh token mints a fresh access token", () => {
  const verifier = "refresh-verifier";
  const { code } = oauth.mintAuthorizeGrant({
    client_id: "lumo-super-agent",
    redirect_uri: "https://lumo.example/api/connections/callback",
    scope: "food:read",
    code_challenge: base64urlSha256(verifier),
    code_challenge_method: "S256",
    user_id: "food-user:refresh@example.com",
  });
  const tokens = oauth.exchangeCodeForTokens({
    code,
    code_verifier: verifier,
    redirect_uri: "https://lumo.example/api/connections/callback",
    client_id: "lumo-super-agent",
  });

  const refreshed = oauth.refreshAccessToken({
    refresh_token: tokens.refresh_token,
    client_id: "lumo-super-agent",
  });
  assert.match(refreshed.access_token, /^fa_/);
  assert.deepEqual(oauth.resolveBearer(refreshed.access_token), {
    user_id: "food-user:refresh@example.com",
    scopes: ["food:read"],
  });
});

if (fail > 0) {
  console.error(`\n${fail} failed, ${pass} passed`);
  process.exit(1);
}
console.log(`\n${pass} passed`);

function base64urlSha256(input) {
  return createHash("sha256").update(input).digest("base64url");
}
