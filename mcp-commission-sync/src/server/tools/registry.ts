import type { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { hasAnyPermission, requireSession, type UserSession } from "../../auth/context.js";
import { backendStatus, createBackendClient, describeBackendError } from "../../backend/client.js";

export interface ToolDefinition<Args extends ZodRawShapeCompat = ZodRawShapeCompat> {
  name: string;
  description: string;
  inputSchema: Args;
  /** OR semantics: caller needs at least one of these backend permission strings. */
  requiredPermissions: string[];
  handler: ToolCallback<Args>;
}

/**
 * Type-safe constructor used by each tools/*.ts file. The cast to the
 * widened ToolDefinition is intentional and localized here: it's what lets
 * heterogeneous tool definitions (different Args shapes) live in one flat
 * ALL_TOOLS array while each individual definition site stays fully typed.
 */
export function defineTool<Args extends ZodRawShapeCompat>(def: ToolDefinition<Args>): ToolDefinition {
  return def as unknown as ToolDefinition;
}

/**
 * Re-checks the caller's permissions against a tool's requirement inside
 * the handler itself. This is intentionally redundant with tools/list
 * filtering (see getToolsForSession) - it's the "double-layer" guard so a
 * filtering bug, a stale client-side tool cache, or a direct tools/call
 * bypass can never result in an unauthorized mutation. Authorization is
 * checked against the backend's own granular permission strings (e.g.
 * "commissions:schedules:create"), fetched live from the backend at
 * session start - not a small hardcoded role enum.
 */
export function assertPermission(toolName: string, requiredPermissions: string[]): UserSession {
  const session = requireSession();
  if (!hasAnyPermission(session, requiredPermissions)) {
    throw new Error(
      `Caller is not authorized to call '${toolName}'. Required one of: ${requiredPermissions.join(", ")}.`
    );
  }
  return session;
}

/**
 * Second half of the double-layer guard: explicitly confirms the insurer
 * being touched actually belongs to the caller's tenant, via a real
 * backend round-trip using the caller's own token - never trusting the
 * insurerId argument at face value just because it parsed as a string.
 */
export async function assertPermissionAndTenant(
  toolName: string,
  requiredPermissions: string[],
  opts: { insurerIds?: string[] } = {}
): Promise<UserSession> {
  const session = assertPermission(toolName, requiredPermissions);

  const insurerIds = [...new Set(opts.insurerIds ?? [])];
  if (insurerIds.length > 0) {
    const client = createBackendClient(session.accessToken);
    await Promise.all(
      insurerIds.map(async (insurerId) => {
        try {
          await client.get(`/insurers/${insurerId}`);
        } catch (err) {
          const status = backendStatus(err);
          if (status === 404 || status === 403) {
            throw new Error(
              `Insurer '${insurerId}' is not accessible for tenant '${session.tenantId}' (backend responded ${status}). Refusing to proceed with '${toolName}'.`
            );
          }
          throw new Error(describeBackendError(err));
        }
      })
    );
  }

  return session;
}

let cachedAllTools: ToolDefinition[] | null = null;

/**
 * Lazily aggregates every tool definition. Lazy + cached so the individual
 * tools/*.ts modules (which import from this file) never hit a circular
 * import ordering issue at module-load time.
 */
export async function getAllTools(): Promise<ToolDefinition[]> {
  if (cachedAllTools) return cachedAllTools;

  const [{ READ_TOOLS }, { WRITE_TOOLS }] = await Promise.all([import("./read.js"), import("./write.js")]);

  cachedAllTools = [...READ_TOOLS, ...WRITE_TOOLS];
  return cachedAllTools;
}

/**
 * Implements "Dynamic Tool Filtering": a session without any write
 * permission must never even see write/apply-shaped tools in tools/list,
 * not just be blocked from calling them.
 */
export async function getToolsForSession(session: UserSession): Promise<ToolDefinition[]> {
  const all = await getAllTools();
  return all.filter((tool) => hasAnyPermission(session, tool.requiredPermissions));
}
