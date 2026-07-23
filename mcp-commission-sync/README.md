# mcp-commission-sync

A remote MCP server that lets an AI agent reconcile insurer commission-schedule
updates against InsureOps's own backend REST API, never a database directly.

## Workflow this server supports

1. An insurer issues new/updated commission terms (circular, rate card, email, PDF).
2. A broker-side user pastes/uploads that content into the AI chat.
3. The AI normalizes it into a structured `CommissionScheduleInput` and calls
   `diff_commission_schedule_change`, which compares it against whatever's currently
   active on that schedule and returns a structured diff - not an LLM-eyeballed one.
4. The AI shows the user exactly what will change (scope, rule criteria, rate table).
5. Only on explicit user confirmation does the AI call `create_change_request` and then
   `apply_change_request` (with a literal `confirm: true`) to write it. Proposing and
   applying are always two separate, separately-authorized tool calls.

## Security model

- **Zero Tenant Parameter Rule** - `tenantId`, `accessToken`, and permissions never
  appear in any tool's Zod schema. They live only in
  [`sessionContext`](src/auth/context.ts), populated once per request by
  [`authMiddleware`](src/auth/middleware.ts) from the caller's own token.
- **Transport-level auth** - every request's Bearer token is decoded for its claims and
  validated live against the backend's own `GET /auth/me/permissions` (see "Auth model"
  below for why - this backend has no JWKS to verify signatures against locally).
- **Dynamic tool filtering** - each request builds a fresh `McpServer` registering only
  the tools the caller's live backend permissions allow (see `buildServerForSession` in
  [`src/server/index.ts`](src/server/index.ts)). A session without any
  `commissions:schedules:*` write permission never even sees `apply_change_request` in
  `tools/list`.
- **Double-layer guard** - every write handler re-checks permissions and, where
  `insurerIds` are involved, tenant ownership via a real backend round-trip
  (`assertPermissionAndTenant` in
  [`src/server/tools/registry.ts`](src/server/tools/registry.ts)), even though the tool
  was already filtered out of the list for unauthorized sessions.
- **Remote API proxying only** - no DB driver, no ORM, no connection string anywhere in
  this service. Every tool ends in one backend call via
  [`src/backend/client.ts`](src/backend/client.ts), forwarding the caller's own
  `Authorization: Bearer <accessToken>` so the backend enforces tenant isolation the
  same way it does for normal app traffic. This client uses `undici` with HTTP/2
  enabled, not `axios` - see "Auth model" below for why that matters here.
- **Compute-then-confirm writes** - `diff_commission_schedule_change` is side-effect-free.
  Applying a diff is a separate, explicitly-confirmed (`confirm: true`), permission-gated
  tool. Nothing mutates commission data in a single hop.
- **Idempotency & audit** - every staged change carries a `sourceReference` (e.g.
  "Insurer circular #4521, received 2026-07-20") for the audit trail.

## Project structure

```text
src/
├── auth/
│   ├── context.ts       # AsyncLocalStorage session type (tenantId/userId/roles/permissions)
│   └── middleware.ts     # Token decode + live backend validation
├── types/
│   └── commissionSchedule.ts # Shared Zod schemas (schedule/version/dimension/rate/diff)
├── backend/
│   └── client.ts         # undici (HTTP/2) wrapper for MAIN_APP_API_URL calls + envelope unwrap
└── server/
    ├── tools/
    │   ├── read.ts        # list_insurers, list_products, list_plans, list_commission_schedules, ...
    │   ├── write.ts        # diff/create/apply/reject_change_request, activate/deactivate
    │   ├── scheduleDiff.ts  # Pure diff computation (this server, not the backend - see SPEC.md)
    │   ├── diffStore.ts      # In-memory diff/change-request store with TTL
    │   ├── permissions.ts     # Backend permission-string constants
    │   ├── registry.ts         # combines tools + requiredPermissions metadata + guards
    │   └── responses.ts         # CallToolResult helpers
    └── index.ts                  # Express + Streamable HTTP server & route bindings
```

## Real backend REST contract (devapp.insureops.io)

| Tool | Method | Path |
|---|---|---|
| `list_insurers` | GET | `/insurers` |
| `list_products` | GET | `/products` |
| `list_plans` | GET | `/plans?productId=` |
| `list_commission_schedules` | GET | `/commission-schedules` |
| `get_commission_schedule` | GET | `/commission-schedules/{id}` |
| `list_schedule_dimensions` | GET | `/commission-schedules/registry/dimensions` |
| `list_schedule_basis_types` | GET | `/commission-schedules/registry/basis-types?lobProfile=` |
| `list_change_requests` / `get_change_request` | - | served from this server's own in-memory store, not the backend |
| `diff_commission_schedule_change` | GET | `/commission-schedules/{scheduleId}` (read only, diff computed locally) |
| `create_change_request` / `reject_change_request` | - | staged in this server's own in-memory store |
| `apply_change_request` | POST or PUT | `/commission-schedules` (create) or `/commission-schedules/{id}` (update) |
| `activate_schedule_version` | POST | `/commission-schedules/{id}/versions/{versionId}/activate` |
| `deactivate_commission_schedule` | PUT | `/commission-schedules/{id}` with `{ status: "INACTIVE" }` |
| ownership check (`assertPermissionAndTenant`) | GET | `/insurers/{insurerId}` |
| token validation (`authMiddleware`) | GET | `/auth/me/permissions` |

## Setup

```bash
npm install
cp .env.example .env   # fill in real values - see table below
npm run dev             # tsx watch, loads .env via dotenv
```

```bash
npm run build            # tsc -> dist/
npm start                 # node dist/server/index.js
```

## Environment variables

| Variable | Purpose |
|---|---|
| `MAIN_APP_API_URL` | Base URL of the backend REST API, **including** the `/api/v1` prefix |
| `MAIN_APP_API_TIMEOUT_MS` | Outbound call timeout |
| `DIFF_TTL_SECONDS` | How long a computed `diffId`/staged change request stays valid before this server refuses to consume it |
| `DB_PATH` | Path to the local SQLite file backing diffs/change-requests (defaults to `./data/commission-sync.sqlite`). Created automatically on startup; survives restarts. Single local file - not shared across instances (see "Auth model" / scaling caveats) |
| `PORT`, `ALLOWED_ORIGINS`, `NODE_ENV`, `LOG_LEVEL` | Standard service config |
| `PUBLIC_URL` | The public `https://` base URL brokers reach this server at - used by `/setup` (below) to render the right MCP URL. Optional; derived from the request if unset. |

No JWKS/issuer/audience env vars exist - see "Auth model" below for why.

### Local testing without real credentials

Setting `DISABLE_AUTH=true` skips token validation entirely and treats every request as
a fixed dev session (`DEV_TENANT_ID`, `DEV_USER_ID`, `DEV_ROLES`, `DEV_PERMISSIONS`,
`DEV_ACCESS_TOKEN`). This is meant only for poking at tools with something like MCP
Inspector before you have real credentials wired up - **the server refuses to boot with
`DISABLE_AUTH=true` if `NODE_ENV=production`**, and logs a loud warning on every startup
while active. Note that with auth disabled, your backend still receives whatever
`DEV_ACCESS_TOKEN` you set as the forwarded Bearer token, so real backend calls will
still be rejected by the backend's own auth unless that value happens to be valid there
too.

## Auth model

This backend does **not** use an external IdP or JWKS. `POST /auth/login`
(email+password) issues its own **HS256**-signed token directly, with no `iss`/`aud`
claims - there is no public key this server could verify a signature against locally.
Instead, `authMiddleware` decodes the token for its claims (`tenantId`, `sub`, `roles`,
`exp`) and separately calls the backend's own `GET /auth/me/permissions` with the same
token: if the backend accepts it, the token is real, and the response's live permission
list becomes the session's `permissions`. Every actual write this server performs also
forwards the same token back to the backend, which independently re-validates it - so a
forged/expired token can never result in an unauthorized write, only, at worst, an
unhelpful `tools/list` until it's rejected here.

Authorization throughout this server is permission-string based (e.g.
`commissions:schedules:create`), matching the backend's own granular RBAC model, not a
small hardcoded role enum.

**A related, easy-to-miss gotcha**: because the token embeds the caller's entire
permission list, it's ~9KB - large enough that nginx in front of this backend rejects
it as `400 Request Header Or Cookie Too Large` over plain HTTP/1.1 (which is what
`axios`/Node's built-in `http`/`https` always speak). `curl` never hits this because it
negotiates HTTP/2 via ALPN by default. `src/backend/client.ts` uses `undici` with
`Agent({ allowH2: true })` specifically to match curl's behavior - don't reintroduce
`axios` (or any other HTTP/1.1-only client) for calls to this backend.

## Broker self-service setup (`/setup`)

Full OAuth is deferred for v1 (see `SPEC.md` Section 9) - brokers connecting from their
own AI client (Claude Desktop, etc.) get a bearer token via a simple hosted form
instead of being expected to call the backend's login endpoint themselves:

- `GET /setup` - a plain HTML form asking for the broker's normal InsureOps
  email/password.
- `POST /setup` - forwards those credentials once to the backend's own
  `POST /auth/login` (via `loginWithPassword` in `src/backend/client.ts`), then renders
  the exact JSON snippet to paste into the client's MCP config (`url` +
  `Authorization` header) - never stores or logs the password.
- Rate-limited per-IP (10 requests / 15 min) to blunt use as a login-brute-force proxy.
- **Known limitation, by design for v1**: tokens typically expire in ~24h (whatever the
  backend's login response reports as `expiresIn`) - brokers just revisit `/setup` for a
  fresh one when their client starts getting 401s. There is no refresh-token flow.
- This route is unauthenticated by definition (it's how you *get* credentials) and
  handles real passwords - **must** only ever be served over HTTPS in any real
  deployment; never point a broker at a plain-HTTP URL for this.

## Deployment notes

- Run behind TLS termination (load balancer/API gateway) - never accept plaintext. This
  container does not terminate TLS itself.
- `AsyncLocalStorage` context is per-request and this server builds a fresh `McpServer`
  per request (stateless Streamable HTTP, `sessionIdGenerator: undefined`) - safe to run
  multiple replicas behind a load balancer with **one exception**, immediately below.
- **Caveat**: `diffStore.ts` (diff/change-request audit trail) is backed by a local
  SQLite file (`DB_PATH`), not a shared database. It survives a process restart but is
  still single-instance: a `diffId`/`changeRequestId` minted on one replica won't
  resolve on another. Fine for one instance; back it with Postgres/Redis before running
  more than one.
- `diff_commission_schedule_change` calls are rate-limited per-tenant (see
  `diffRateLimiter` in `src/server/index.ts`).
- Every tool call is logged with tool name, tenantId, userId, and outcome; the raw
  `accessToken` is never logged.

### Running it (Docker)

```bash
cp .env.example .env   # fill in MAIN_APP_API_URL, ALLOWED_ORIGINS, etc.
docker compose build
docker compose up -d
curl http://localhost:3000/healthz   # -> {"status":"ok"}
```

`Dockerfile` builds a `node:20-slim` (glibc, not alpine - `better-sqlite3` ships
prebuilt glibc binaries, avoiding a musl compile step) multi-stage image and mounts
`/app/data` as a named volume so the SQLite audit trail survives redeploys.
`docker-compose.yml` does **not** terminate TLS - put it behind whatever reverse proxy
your infra already runs (nginx/Caddy/Traefik/cloud load balancer) and point that at
`http://<host>:3000`.

**Picking an actual host is an infra decision this repo can't make for you** - it
depends on what your organization already runs (a Kubernetes cluster, a plain VM, a
managed container platform, etc.). Once a target is chosen: set `ALLOWED_ORIGINS` to
the real origin(s) that will connect (a broker's AI client typically doesn't send an
`Origin` header at all for non-browser connections, so this mainly matters for
browser-based MCP clients), and update the real URL below.

**Real URL**: not yet deployed - update this line once a host is chosen (see
`setup-page` in the production-readiness plan, which depends on this).

## Verification checklist

- [x] No tool's Zod schema contains `tenantId`, `accessToken`, or any credential.
- [x] `tools/list` output differs based on the caller's live backend permissions - write
      tools are never registered on a read-only session's server instance in the first
      place.
- [x] `apply_change_request` re-checks permissions inside the handler and requires a
      literal `confirm: true`, and surfaces backend errors clearly.
- [x] Every staged change carries a `sourceReference` for the audit trail.
- [x] Zero DB driver dependencies in `package.json` beyond `better-sqlite3` (local file,
      no separate database service to operate).
- [x] Verified end-to-end against the real dev backend (`devapp.insureops.io`) using a
      real login-issued token: `auth/me/permissions` validation, insurers/products/
      plans/commission-schedules reads, and the dimension/basis-type registries.
- [x] `apply_change_request` (create + update), `activate_schedule_version`, and
      `deactivate_commission_schedule` all fired against a disposable test schedule on
      the dev tenant and cleaned up afterwards - see `SPEC.md` Section 10 for the full
      results, including two real contract gaps this surfaced (Section 11, item 6).
- [x] Automated test suite (`npm test`) covers diff logic, a negative permission-
      filtering case, and a mocked write-flow including the stale-diff and double-apply
      guards.
- [ ] Not yet deployed to a persistent, HTTPS-reachable host - see "Running it (Docker)"
      above; the Docker build itself has not been run in this environment (no local
      Docker daemon available) and should be smoke-tested on whatever host is chosen
      before relying on it.
- [ ] No broker has yet done a live end-to-end smoke test with a genuinely restricted
      (non-admin) permission set.
