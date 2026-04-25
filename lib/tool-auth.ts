import { errorResponse } from "./agent-http";
import { resolveBearer } from "./oauth-provider";

export interface ToolPrincipal {
  user_id: string;
  scopes: string[];
}

export function requireToolBearer(
  req: Request,
  requiredScopes: string[],
): ToolPrincipal | Response {
  const auth = req.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(auth);
  if (!match) {
    return errorResponse("unauthorized", 401, "Missing bearer token.");
  }

  const principal = resolveBearer(match[1]);
  if (!principal) {
    return errorResponse("unauthorized", 401, "Invalid or expired bearer token.");
  }

  const granted = new Set(principal.scopes);
  const missing = requiredScopes.filter((scope) => !granted.has(scope));
  if (missing.length > 0) {
    return errorResponse("insufficient_scope", 403, "Bearer token lacks required scope.", {
      required_scopes: requiredScopes,
      missing_scopes: missing,
    });
  }

  return principal;
}
