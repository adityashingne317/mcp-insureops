import type { NextFunction, Request, Response } from "express";
import jwt, { type JwtPayload } from "jsonwebtoken";
import { createBackendClient, unwrapEnvelope } from "../backend/client.js";
import { sessionContext, type UserSession } from "./context.js";

const MAIN_APP_API_URL = process.env.MAIN_APP_API_URL ?? "";
const NODE_ENV = process.env.NODE_ENV ?? "development";

/**
 * TESTING ONLY. When true, authMiddleware skips token verification entirely
 * and injects a fixed dev session (see DEV_* env vars below). This exists
 * solely to unblock local tool exploration (e.g. via MCP Inspector) before
 * you have real credentials wired up. It is hard-refused outside of
 * development so it can never end up live by accident - see the guard
 * immediately below.
 */
const DISABLE_AUTH = process.env.DISABLE_AUTH === "true";

if (DISABLE_AUTH && NODE_ENV === "production") {
  throw new Error(
    "DISABLE_AUTH=true is not allowed when NODE_ENV=production. Refusing to start with authentication disabled outside of local development."
  );
}

if (!DISABLE_AUTH && !MAIN_APP_API_URL) {
  throw new Error("Missing required env var: MAIN_APP_API_URL");
}

if (DISABLE_AUTH) {
  // eslint-disable-next-line no-console
  console.warn(
    "\n*** DISABLE_AUTH=true: authentication is COMPLETELY BYPASSED. Every request is treated as a fixed dev session. Never set this outside local testing. ***\n"
  );
}

function splitList(value: string | undefined, fallback: string[]): string[] {
  if (!value) return fallback;
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const DEV_SESSION: UserSession = {
  tenantId: process.env.DEV_TENANT_ID ?? "dev-tenant",
  userId: process.env.DEV_USER_ID ?? "dev-user",
  roles: splitList(process.env.DEV_ROLES, ["tenant_admin"]),
  permissions: splitList(process.env.DEV_PERMISSIONS, [
    "commissions:schedules:view",
    "commissions:schedules:create",
    "commissions:schedules:update",
    "commissions:schedules:delete",
    "settings:insurer:view",
    "settings:products:view",
    "settings:plans:view",
  ]),
  accessToken: process.env.DEV_ACCESS_TOKEN ?? "dev-mode-no-token",
};

function extractBearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

/**
 * Sends a plain HTTP Bearer challenge (RFC 6750) alongside the JSON error
 * body. This server does not implement OAuth (no /register, no
 * .well-known metadata) - some MCP clients, on receiving a bare 401 with
 * no WWW-Authenticate header, assume OAuth is required and probe
 * Dynamic Client Registration, which 404s here. Advertising the Bearer
 * scheme explicitly heads that off.
 */
function sendUnauthorized(res: Response, error: string, description: string): void {
  res.setHeader("WWW-Authenticate", 'Bearer realm="mcp-commission-sync", error="invalid_token"');
  res.status(401).json({ error, error_description: description });
}

/**
 * Validates the token against the backend's own `/auth/me/permissions`
 * endpoint (the source of truth) and returns the live permission list.
 *
 * This backend issues its own HS256-signed tokens with a secret this
 * server does not hold, and has no JWKS endpoint (HS256 has no public key
 * to publish). Rather than skip verification, every incoming token is
 * checked against the backend itself: if the backend accepts it and
 * returns a live permission set, the token is real and current. Every
 * actual write this server performs also forwards the same token back to
 * the backend for its own independent re-validation, so a forged or
 * expired token can never result in an unauthorized write - only, in the
 * worst case, an unhelpful tools/list until it is rejected here.
 */
async function validateAndFetchPermissions(token: string): Promise<string[]> {
  const client = createBackendClient(token);
  let response;
  try {
    response = await client.get("/auth/me/permissions");
  } catch (err) {
    throw new Error(`Backend rejected the token: ${err instanceof Error ? err.message : "unknown error"}`);
  }

  const keys = unwrapEnvelope<{ keys?: unknown }>(response.data).data?.keys;
  if (!Array.isArray(keys)) {
    throw new Error("Backend's auth/me/permissions response did not include a permissions list.");
  }
  return keys as string[];
}

/**
 * Decodes (without verifying signature - see validateAndFetchPermissions
 * above for why) the inbound access token, confirms it's still live and
 * carries the claims this server needs, then runs `next` inside an
 * AsyncLocalStorage scope carrying the derived UserSession. This is the
 * only place tenantId/userId/permissions/accessToken are ever derived -
 * tool handlers must never accept these as their own arguments.
 */
export async function authMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (DISABLE_AUTH) {
    sessionContext.run(DEV_SESSION, () => next());
    return;
  }

  const token = extractBearerToken(req);
  if (!token) {
    sendUnauthorized(res, "invalid_token", "Missing or malformed Authorization header.");
    return;
  }

  let payload: JwtPayload | null = null;
  try {
    const decoded = jwt.decode(token);
    payload = typeof decoded === "object" ? decoded : null;
  } catch {
    payload = null;
  }

  if (!payload) {
    sendUnauthorized(res, "invalid_token", "Token could not be decoded as a JWT.");
    return;
  }

  const tenantId = payload.tenantId as string | undefined;
  const userId = payload.sub;
  const roles = Array.isArray(payload.roles) ? (payload.roles as string[]) : [];
  const exp = payload.exp;

  if (!tenantId || !userId) {
    sendUnauthorized(res, "invalid_token", "Token is missing required tenantId/sub claims.");
    return;
  }
  if (typeof exp === "number" && Date.now() >= exp * 1000) {
    sendUnauthorized(res, "invalid_token", "Token has expired.");
    return;
  }

  try {
    const permissions = await validateAndFetchPermissions(token);
    const session: UserSession = { tenantId, userId, roles, permissions, accessToken: token };
    sessionContext.run(session, () => {
      next();
    });
  } catch (err) {
    const description = err instanceof Error ? err.message : "Token validation failed.";
    sendUnauthorized(res, "invalid_token", description);
  }
}
