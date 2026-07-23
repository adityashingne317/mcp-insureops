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

/**
 * Visual style intentionally mirrors the real InsureOps sign-in page (logo,
 * card, "Welcome back!" heading, input/button styling) so this feels like a
 * trusted part of the same product rather than a random internal tool - see
 * the reference screenshot this was matched against. It is NOT the real
 * InsureOps login page (different purpose: mints an MCP config, not an app
 * session) - the "MCP Connector" label under the logo and the explanatory
 * copy make that distinction clear rather than silently impersonating it.
 * Elements from the reference that don't apply to this one-shot flow
 * (Remember me, Forgot password, Sign up) are intentionally omitted rather
 * than kept as dead links.
 */
function pageShell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    margin: 0; min-height: 100vh; color: #1a1a2e;
    background: #eef0f6;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    padding: 40px 20px;
  }
  .brand { display: flex; align-items: center; gap: 10px; margin-bottom: 28px; }
  .brand-name { font-size: 1.15rem; font-weight: 800; letter-spacing: -0.02em; color: #17172b; line-height: 1.1; }
  .brand-sub { font-size: 0.72rem; color: #8b8ca3; line-height: 1.1; margin-top: 2px; }
  .card {
    width: 100%; max-width: 420px; background: #ffffff; border-radius: 18px;
    padding: 36px 32px; box-shadow: 0 12px 32px rgba(23, 23, 43, 0.08);
  }
  .card h1 { font-size: 1.5rem; margin: 0 0 6px; color: #17172b; }
  .card .subtitle { color: #8b8ca3; font-size: 0.92rem; margin: 0 0 24px; }
  .card p.desc { color: #5b5c72; font-size: 0.9rem; line-height: 1.5; margin: 0 0 20px; }
  label { display: block; margin: 0 0 6px; font-weight: 600; font-size: 0.85rem; color: #33334a; }
  label .req { color: #ef4444; margin-left: 2px; }
  .field { margin-bottom: 18px; }
  .field-wrap { position: relative; }
  input[type="email"], input[type="password"], input[type="text"] {
    width: 100%; padding: 11px 14px; font-size: 0.95rem; border: 1px solid #dfe1eb;
    border-radius: 10px; background: #fbfbfd; color: #17172b; outline: none;
  }
  input[type="email"]:focus, input[type="password"]:focus, input[type="text"]:focus {
    border-color: #818cf8; background: #ffffff; box-shadow: 0 0 0 3px rgba(129, 140, 248, 0.15);
  }
  .toggle-visibility {
    position: absolute; right: 12px; top: 50%; transform: translateY(-50%);
    background: none; border: none; cursor: pointer; padding: 4px; color: #9a9bb0; margin: 0;
  }
  .toggle-visibility:hover { color: #5b5c72; background: none; }
  button[type="submit"] {
    width: 100%; margin-top: 8px; padding: 12px 18px; font-size: 0.98rem; font-weight: 700;
    border: none; border-radius: 10px; background: #818cf8; color: white; cursor: pointer;
  }
  button[type="submit"]:hover { background: #6a75f0; }
  pre { background: #17172b; color: #e2e8f0; padding: 16px; border-radius: 10px; overflow-x: auto; font-size: 0.82rem; }
  .note { background: #fef9c3; border: 1px solid #fde68a; padding: 12px 14px; border-radius: 10px; font-size: 0.85rem; margin: 20px 0 0; color: #573a08; }
  .error { background: #fee2e2; border: 1px solid #fca5a5; padding: 12px 14px; border-radius: 10px; margin-bottom: 20px; font-size: 0.88rem; color: #991b1b; }
  code { background: #f1f5f9; padding: 2px 5px; border-radius: 4px; }
  a { color: #6a75f0; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .back-link { display: inline-block; margin-top: 20px; font-size: 0.88rem; }
</style>
</head>
<body>
<div class="brand">
  <svg width="30" height="30" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="8.5" cy="12" r="5.5" stroke="#6366f1" stroke-width="2.4"/>
    <circle cx="15.5" cy="12" r="5.5" stroke="#4f46e5" stroke-width="2.4"/>
  </svg>
  <div>
    <div class="brand-name">insureops</div>
    <div class="brand-sub">MCP Connector</div>
  </div>
</div>
${body}
</body>
</html>`;
}

function formPage(errorMessage?: string): string {
  const errorBlock = errorMessage
    ? `<div class="error"><strong>Sign-in failed:</strong> ${escapeHtml(errorMessage)}</div>`
    : "";
  return pageShell(
    "Sign in - Insureops MCP Connector",
    `<div class="card">
  <h1>Welcome back!</h1>
  <p class="subtitle">Sign in to connect your AI client</p>
  <p class="desc">Use your normal InsureOps email and password. You'll get an MCP config
  snippet to paste into Cursor, Claude Desktop, or any other MCP-compatible client - it
  will only ever be able to see and do what your account's own permissions already allow.</p>
  ${errorBlock}
  <form method="POST" action="/setup" autocomplete="off">
    <div class="field">
      <label for="email">Email<span class="req">*</span></label>
      <input type="email" id="email" name="email" placeholder="Enter email" required autocomplete="username">
    </div>
    <div class="field">
      <label for="password">Password<span class="req">*</span></label>
      <div class="field-wrap">
        <input type="password" id="password" name="password" placeholder="Enter password" required autocomplete="current-password">
        <button type="button" class="toggle-visibility" onclick="var f=document.getElementById('password'); f.type = f.type==='password' ? 'text' : 'password';" aria-label="Show password">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.6"/></svg>
        </button>
      </div>
    </div>
    <button type="submit">Sign In</button>
  </form>
  <p class="note">Your password is sent once, directly to InsureOps's own sign-in endpoint,
  and is never stored by this page. The resulting token typically expires in ~24h - just
  revisit this page to get a fresh one when your client starts rejecting calls.</p>
</div>`
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
    "Your MCP config - Insureops MCP Connector",
    `<div class="card">
  <h1>You're connected</h1>
  <p class="subtitle">Copy this into your AI client</p>
  <p class="desc">Paste this into your AI client's MCP configuration (for Claude Desktop,
  this is the <code>mcpServers</code> block in its config file):</p>
  <pre>${escapeHtml(JSON.stringify(config, null, 2))}</pre>
  <div class="note">${escapeHtml(expiryNote)}</div>
  <a class="back-link" href="/setup">&larr; Back</a>
</div>`
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
