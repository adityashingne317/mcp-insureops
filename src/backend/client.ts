import { Agent, request as undiciRequest } from "undici";

const MAIN_APP_API_URL = process.env.MAIN_APP_API_URL ?? "";
const MAIN_APP_API_TIMEOUT_MS = Number(process.env.MAIN_APP_API_TIMEOUT_MS ?? "10000");

if (!MAIN_APP_API_URL) {
  throw new Error("Missing required env var: MAIN_APP_API_URL");
}

/**
 * This backend embeds the caller's full permission list directly in its own
 * JWTs, making tokens ~9KB - large enough that nginx in front of this
 * backend rejects them as "Request Header Or Cookie Too Large" over plain
 * HTTP/1.1 (Node's default `http`/`https` client, and therefore axios,
 * never negotiate HTTP/2). `curl` succeeds against the same backend only
 * because it negotiates HTTP/2 via ALPN by default. Using an HTTP/2-capable
 * undici Agent here matches curl's wire behavior instead of trying to work
 * around header size some other way.
 */
const h2Agent = new Agent({ allowH2: true, connect: { timeout: MAIN_APP_API_TIMEOUT_MS } });

export class BackendRequestError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "BackendRequestError";
    this.status = status;
  }
}

export interface BackendResponse<T = unknown> {
  status: number;
  data: T;
}

function buildUrl(path: string, params?: Record<string, unknown>): string {
  const url = new URL(path.startsWith("http") ? path : `${MAIN_APP_API_URL}${path}`);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

async function doRequest<T = unknown>(
  method: string,
  accessToken: string,
  path: string,
  opts: { params?: Record<string, unknown>; body?: unknown } = {}
): Promise<BackendResponse<T>> {
  const url = buildUrl(path, opts.params);
  const headers: Record<string, string> = { authorization: `Bearer ${accessToken}` };
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.body);
  }

  let res;
  try {
    res = await undiciRequest(url, {
      method: method as "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
      headers,
      body,
      dispatcher: h2Agent,
      headersTimeout: MAIN_APP_API_TIMEOUT_MS,
      bodyTimeout: MAIN_APP_API_TIMEOUT_MS,
    });
  } catch (err) {
    throw new BackendRequestError(
      `Backend request failed: ${err instanceof Error ? err.message : "unknown error"}`
    );
  }

  const text = await res.body.text();
  let data: unknown = text;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      // leave as raw text - e.g. an HTML error page from a proxy in front of the backend
    }
  }

  if (res.statusCode >= 400) {
    const backendMessage =
      (data as { message?: string; error?: string } | undefined)?.message ??
      (data as { message?: string; error?: string } | undefined)?.error;
    throw new BackendRequestError(
      `Backend responded ${res.statusCode}${backendMessage ? `: ${backendMessage}` : ""}`,
      res.statusCode
    );
  }

  return { status: res.statusCode, data: data as T };
}

/**
 * Exchanges an email/password for the backend's own access token, via the
 * same `POST /auth/login` this server always relied on the caller to call
 * themselves. Used only by the /setup self-service page - the credential
 * is forwarded once and never stored or logged by this server.
 */
export async function loginWithPassword(
  email: string,
  password: string
): Promise<{ accessToken: string; expiresIn?: number; tokenType?: string }> {
  const url = buildUrl("/auth/login");
  let res;
  try {
    res = await undiciRequest(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
      dispatcher: h2Agent,
      headersTimeout: MAIN_APP_API_TIMEOUT_MS,
      bodyTimeout: MAIN_APP_API_TIMEOUT_MS,
    });
  } catch (err) {
    throw new BackendRequestError(`Login request failed: ${err instanceof Error ? err.message : "unknown error"}`);
  }

  const text = await res.body.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }

  if (res.statusCode >= 400) {
    const backendMessage = (data as { message?: string } | undefined)?.message;
    throw new BackendRequestError(
      `Login failed${backendMessage ? `: ${backendMessage}` : ""}`,
      res.statusCode
    );
  }

  const envelope = unwrapEnvelope<{ accessToken?: string; expiresIn?: number; tokenType?: string }>(data);
  if (!envelope.data?.accessToken) {
    throw new BackendRequestError("Login succeeded but the response did not include an accessToken.");
  }
  return {
    accessToken: envelope.data.accessToken,
    expiresIn: envelope.data.expiresIn,
    tokenType: envelope.data.tokenType,
  };
}

/**
 * Creates a per-call client carrying the *caller's own* access token, never
 * a service/admin token. This is what lets the backend enforce tenant
 * isolation exactly as it does for normal application traffic - this
 * service has no DB driver and no independent notion of "which tenant" a
 * request belongs to beyond forwarding the token.
 */
export function createBackendClient(accessToken: string): {
  get: <T = unknown>(path: string, opts?: { params?: Record<string, unknown> }) => Promise<BackendResponse<T>>;
  post: <T = unknown>(path: string, body?: unknown) => Promise<BackendResponse<T>>;
  put: <T = unknown>(path: string, body?: unknown) => Promise<BackendResponse<T>>;
  patch: <T = unknown>(path: string, body?: unknown) => Promise<BackendResponse<T>>;
  delete: <T = unknown>(path: string) => Promise<BackendResponse<T>>;
} {
  return {
    get: (path, opts) => doRequest("GET", accessToken, path, opts),
    post: (path, body) => doRequest("POST", accessToken, path, { body }),
    put: (path, body) => doRequest("PUT", accessToken, path, { body }),
    patch: (path, body) => doRequest("PATCH", accessToken, path, { body }),
    delete: (path) => doRequest("DELETE", accessToken, path),
  };
}

/**
 * Normalizes backend error responses into a message safe to surface as a
 * tool error, preserving status-code semantics (e.g. 409 stale version)
 * that handlers rely on instead of swallowing.
 */
export function describeBackendError(err: unknown): string {
  if (err instanceof BackendRequestError) return err.message;
  return err instanceof Error ? err.message : "Unknown backend error.";
}

export function backendStatus(err: unknown): number | undefined {
  return err instanceof BackendRequestError ? err.status : undefined;
}

/**
 * Every response from this backend is wrapped in a fixed envelope
 * (`{ statusCode, message, data, timestamp, path, correlationId, metadata }`).
 * Tool handlers should pull the real payload and pagination metadata
 * through here instead of reaching into `response.data.data` inline
 * everywhere.
 */
export interface BackendEnvelope<T> {
  statusCode: number;
  message: string;
  data: T;
  timestamp?: string;
  path?: string;
  correlationId?: string;
  metadata?: Record<string, unknown>;
}

export function unwrapEnvelope<T>(raw: unknown): { data: T; metadata?: Record<string, unknown> } {
  const env = raw as BackendEnvelope<T>;
  return { data: env?.data, metadata: env?.metadata };
}
