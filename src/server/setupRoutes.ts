import type { Express, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { loginWithPassword } from "../backend/client.js";

/**
 * Self-service token retrieval for brokers connecting from their own
 * general-purpose AI client (Claude Desktop, etc.). Full OAuth is
 * explicitly deferred (see the production-readiness plan / SPEC.md
 * Section 9) - this is the interim path so a broker isn't expected to
 * `curl` the backend's login endpoint themselves.
 *
 * Known limitation, by design for v1: the backend's access tokens expire
 * (typically ~24h - see the login response's own `expiresIn`), so a broker
 * re-visits this page to refresh their config once it does. There is no
 * refresh-token flow here.
 *
 * Security notes:
 * - The submitted email/password is forwarded once to the backend's own
 *   `POST /auth/login` and never stored, logged, or held past that single
 *   request - see `loginWithPassword` in `src/backend/client.ts`.
 * - This form must only ever be served over HTTPS in any real deployment
 *   (see README "Deployment notes") - credentials are being submitted.
 * - Rate-limited per-IP to blunt use of this page as a login-brute-force
 *   proxy against the real backend.
 */
const setupRateLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
});

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function pageShell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 640px; margin: 48px auto; padding: 0 20px; color: #1a1a1a; }
  h1 { font-size: 1.4rem; }
  label { display: block; margin: 16px 0 4px; font-weight: 600; font-size: 0.9rem; }
  input[type="email"], input[type="password"] { width: 100%; padding: 8px 10px; font-size: 1rem; border: 1px solid #ccc; border-radius: 6px; box-sizing: border-box; }
  button { margin-top: 20px; padding: 10px 18px; font-size: 1rem; border: none; border-radius: 6px; background: #2563eb; color: white; cursor: pointer; }
  button:hover { background: #1d4ed8; }
  pre { background: #0f172a; color: #e2e8f0; padding: 16px; border-radius: 8px; overflow-x: auto; font-size: 0.85rem; }
  .note { background: #fef9c3; border: 1px solid #fde68a; padding: 12px 14px; border-radius: 6px; font-size: 0.9rem; margin: 20px 0; }
  .error { background: #fee2e2; border: 1px solid #fca5a5; padding: 12px 14px; border-radius: 6px; }
  code { background: #f1f5f9; padding: 2px 5px; border-radius: 4px; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

function formPage(errorMessage?: string): string {
  const errorBlock = errorMessage
    ? `<div class="error"><strong>Sign-in failed:</strong> ${escapeHtml(errorMessage)}</div>`
    : "";
  return pageShell(
    "Connect to Commission Sync",
    `<h1>Connect your AI client to Commission Sync</h1>
<p>Sign in with your normal InsureOps account below. You'll get an MCP config snippet to
paste into Claude Desktop (or any other MCP-compatible client) - it will only be able to
see and do what your account's own permissions allow.</p>
${errorBlock}
<form method="POST" action="/setup" autocomplete="off">
  <label for="email">Email</label>
  <input type="email" id="email" name="email" required autocomplete="username">
  <label for="password">Password</label>
  <input type="password" id="password" name="password" required autocomplete="current-password">
  <button type="submit">Sign in and generate config</button>
</form>
<p class="note">Your password is sent once to the backend's normal sign-in endpoint and is
never stored by this page. The resulting token typically expires in ~24h - just revisit
this page to get a fresh one when your client starts rejecting calls.</p>`
  );
}

function resultPage(mcpUrl: string, accessToken: string, expiresIn: number | undefined): string {
  const config = {
    mcpServers: {
      "Insureops MCP": {
        url: mcpUrl,
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    },
  };
  const expiryNote =
    typeof expiresIn === "number"
      ? `This token expires in about ${Math.round(expiresIn / 3600)} hour(s). Revisit this page to get a fresh one when it does.`
      : "This token has a limited lifetime. Revisit this page to get a fresh one once your client starts rejecting calls.";
  return pageShell(
    "Your MCP config",
    `<h1>You're connected</h1>
<p>Paste this into your AI client's MCP configuration (for Claude Desktop, this is the
<code>mcpServers</code> block in its config file):</p>
<pre>${escapeHtml(JSON.stringify(config, null, 2))}</pre>
<div class="note">${escapeHtml(expiryNote)}</div>
<p><a href="/setup">&larr; Back</a></p>`
  );
}

function publicMcpUrl(req: Request): string {
  const configured = process.env.PUBLIC_URL;
  if (configured) return `${configured.replace(/\/+$/, "")}/mcp`;
  return `${req.protocol}://${req.get("host")}/mcp`;
}

export function registerSetupRoutes(app: Express): void {
  app.get("/setup", (_req, res) => {
    res.status(200).type("html").send(formPage());
  });

  app.post("/setup", setupRateLimiter, async (req: Request, res: Response) => {
    const email = typeof req.body?.email === "string" ? req.body.email.trim() : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (!email || !password) {
      res.status(400).type("html").send(formPage("Email and password are both required."));
      return;
    }
    try {
      const { accessToken, expiresIn } = await loginWithPassword(email, password);
      res.status(200).type("html").send(resultPage(publicMcpUrl(req), accessToken, expiresIn));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Sign-in failed.";
      res.status(401).type("html").send(formPage(message));
    }
  });
}
