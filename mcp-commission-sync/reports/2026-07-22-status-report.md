# Status Report — Commission Rules Sync MCP Server
**Date:** July 22, 2026
**Branch:** `feature/mcp-commission-sync` (main untouched, nothing merged yet)

---

## 1. What this project is

An MCP (Model Context Protocol) server that lets an AI assistant safely sync insurance commission rules from an insurer's document (circular, rate card, PDF) into our system, with a hard rule: **the AI can propose a change and show a diff, but it can never silently apply one.** A human has to explicitly confirm before anything is written to the live system.

## 2. What was done today

### 2.1 Built the server and its core workflow
Built the MCP server end to end: the security model (every action gated by the caller's real permissions, enforced independently at two separate layers so a bug in one can't create a hole), the tool set (browse existing rules, compare an insurer's new document against them, stage the change, and only apply it on explicit confirmation), and the plumbing to talk to our backend.

### 2.2 Tested the mechanics in a general scenario first
Before touching any real data, connected a standard MCP debugging tool ("MCP Inspector") to the running server in a controlled test scenario to validate the mechanics on their own: the connection negotiates correctly, authentication is enforced, the right tools appear, and tool calls execute and return sensible results. This confirmed the plumbing was sound before layering in real credentials and real data.

### 2.3 Connected to the real backend and tuned the tools to match
With connection and authentication confirmed, switched over to our actual `devapp.insureops.io` backend using test tenant credentials. This surfaced a few real specifics of how our backend works that the tools were tuned to match:
- Our backend issues and checks its own tokens directly, so the server now validates every request straight against that single source of truth, every time — not just once at login.
- Access control now follows the exact same fine-grained permission strings our backend already uses internally, so the AI assistant automatically sees only the actions a given user is actually allowed to take.
- The rule data shape was aligned to our actual "Commission Schedule" model (insurer/product/plan scope, rate components, rule criteria).

Also diagnosed and fixed a connectivity issue along the way: our backend embeds a lot of permission data inside its tokens, making them unusually large — large enough that standard web requests were being silently rejected by our backend's server configuration. Fixed by upgrading the server's outbound connection method (HTTP/2, the same thing browsers and `curl` already use invisibly). Worth flagging to the backend team, since it would affect any service integrating with this backend the standard way.

### 2.4 Verified everything end-to-end against the real system
- Logged in with the test tenant credentials and obtained a real access token.
- Confirmed the server independently re-validates that token against our backend on every single request, so a revoked or expired token is rejected immediately, everywhere.
- Confirmed the full list of available actions is correctly filtered by the test user's real permissions.
- Confirmed read-only lookups (insurers, products, plans, existing commission schedules) return real, live data from the test tenant.
- Walked through the full propose → diff → stage → approve/reject workflow and confirmed it behaves as designed.

### 2.5 Documented the design
Wrote up the full technical spec and setup guide in the repo, so anyone picking this up later doesn't have to rediscover today's findings from scratch.

## 3. What the tool can do (once connected)

Once a user is connected with valid credentials, the assistant can, entirely scoped to that user's own real permissions:

- **Browse the current setup** — list the insurers, products, plans, and commission schedules already configured for the tenant, and look up the valid rule-criteria and rate-basis options so any proposed rule always matches what the system actually accepts.
- **Compare an insurer's new document against what's live today** — generate a clear before/after diff covering scope (which insurer/product/plan it applies to), rule criteria, and rate values.
- **Stage a proposed change for review** — bundle a diff into a reviewable request without applying anything yet.
- **Apply a staged change** — but only once a human has explicitly confirmed it; this is the only step that ever writes to the real system.
- **Reject a staged change instead**, with a reason recorded for the audit trail.
- **Roll back or retire a rule set** — reactivate a previous version, or retire an outdated schedule (rules are never permanently deleted, only retired).

## 4. Current status

Working and verified against the real backend, on an isolated feature branch. Nothing has touched `main`, and nothing has been applied to real production data — all testing so far has been against a test tenant with test credentials, and every write-capable action still requires an explicit confirmation step.

## 5. Known limitation to flag

Change requests staged for approval currently live in the server's memory rather than a database. Fine for the current single-server test setup, but it means anything staged-but-not-yet-approved is lost if the server restarts, and it won't work correctly if we ever run more than one copy of this server at once. Not a concern for the current testing phase; worth revisiting before any production rollout.

## 6. Next steps (tomorrow)

Set up this MCP server as a live tool source inside an actual IDE/AI assistant (rather than only the debugging tool used today), so it can be used the way it's actually meant to be used day-to-day, and continue testing from there.
