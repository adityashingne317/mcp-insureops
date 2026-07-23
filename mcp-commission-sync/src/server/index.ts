import "dotenv/config";
import express, { type NextFunction, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { authMiddleware } from "../auth/middleware.js";
import { requireSession } from "../auth/context.js";
import { getToolsForSession } from "./tools/registry.js";
import { registerSetupRoutes } from "./setupRoutes.js";

const PORT = Number(process.env.PORT ?? "3000");
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const NODE_ENV = process.env.NODE_ENV ?? "development";
const LOG_LEVEL = process.env.LOG_LEVEL ?? "info";

function log(event: Record<string, unknown>): void {
  // Structured logging: tool name, tenantId, userId, outcome - the raw
  // accessToken is never included in any log line in this file.
  console.log(JSON.stringify({ level: LOG_LEVEL, ts: new Date().toISOString(), ...event }));
}

const app = express();
app.disable("x-powered-by");
// Respects X-Forwarded-Proto/Host from a reverse proxy - needed so the
// /setup page can render the correct https:// MCP URL when this process
// itself only sees plain HTTP from the proxy.
app.set("trust proxy", true);

function cors(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version"
    );
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  }
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
}
app.use(cors);

app.get("/healthz", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

// Self-service bearer-token retrieval for brokers (see setupRoutes.ts) -
// mounted before authMiddleware (which only applies to /mcp) and before the
// JSON body parser below, since this is a plain HTML form POST.
app.use(express.urlencoded({ extended: false }));
registerSetupRoutes(app);

// Insurer rule documents extracted into `proposedRules` can be large; cap
// body size regardless of which tool ends up receiving it.
app.use(express.json({ limit: "2mb" }));

// Auth middleware verifies the token, populates sessionContext, and only
// then calls next() - every route mounted after this line runs inside that
// AsyncLocalStorage scope for the duration of the request.
app.use("/mcp", authMiddleware);

// diff_commission_schedule_change is the one tool taking bulk structured
// input from the model - rate-limit it specifically, per-tenant, ahead of
// the shared /mcp endpoint (MCP tool calls all arrive as POST /mcp with a
// JSON-RPC body naming the tool being invoked).
const diffRateLimiter = rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: () => requireSession().tenantId,
});

function isDiffCall(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const params = (body as { params?: { name?: string } }).params;
  return params?.name === "diff_commission_schedule_change";
}

app.use("/mcp", (req, res, next) => {
  if (req.method === "POST" && isDiffCall(req.body)) {
    diffRateLimiter(req, res, next);
    return;
  }
  next();
});

/**
 * Builds a fresh McpServer scoped to the current request's session, only
 * registering the tools the caller's permissions allow. This is how
 * "Dynamic Tool Filtering" is enforced: a read-only session's tools/list
 * response never even contains write/apply-shaped tools, because they were
 * never registered on this server instance in the first place - there's no
 * shared, long-lived server whose visible tool set could leak across
 * concurrently-connected sessions with different permissions.
 */
async function buildServerForSession(): Promise<McpServer> {
  const session = requireSession();
  const server = new McpServer({ name: "mcp-commission-sync", version: "0.1.0" });
  const tools = await getToolsForSession(session);

  for (const tool of tools) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema },
      async (args, extra) => {
        const startedAt = Date.now();
        try {
          const result = await tool.handler(args, extra);
          log({
            tool: tool.name,
            tenantId: session.tenantId,
            userId: session.userId,
            roles: session.roles,
            outcome: result.isError ? "error" : "success",
            durationMs: Date.now() - startedAt,
          });
          return result;
        } catch (err) {
          log({
            tool: tool.name,
            tenantId: session.tenantId,
            userId: session.userId,
            roles: session.roles,
            outcome: "exception",
            durationMs: Date.now() - startedAt,
            error: err instanceof Error ? err.message : String(err),
          });
          throw err;
        }
      }
    );
  }

  return server;
}

// Stateless Streamable HTTP: a fresh McpServer + transport per request,
// torn down when the response closes. AsyncLocalStorage context is
// per-request regardless, so this mode is what makes horizontal scaling
// safe with no shared state, per the deployment notes.
app.post("/mcp", async (req, res) => {
  try {
    const server = await buildServerForSession();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({
        error: "internal_error",
        error_description: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }
});

// Streamable HTTP also defines GET (server-initiated stream) and DELETE
// (session termination) on the same endpoint; since this server runs fully
// stateless (sessionIdGenerator: undefined) there is no session to stream
// from or terminate, so these return clean, deliberate responses rather
// than falling through to a generic 404.
app.get("/mcp", (_req, res) => {
  res.status(405).json({
    error: "method_not_allowed",
    error_description: "This server runs in stateless mode; GET /mcp server-initiated streams are not supported.",
  });
});
app.delete("/mcp", (_req, res) => {
  res.status(204).end();
});

app.listen(PORT, () => {
  log({ event: "server_start", port: PORT, nodeEnv: NODE_ENV });
});
