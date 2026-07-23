import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Per-request session, populated exclusively by the auth middleware from a
 * decoded + backend-validated access token. Tool handlers must read
 * tenantId/userId/permissions/accessToken from here - never from a tool's
 * own Zod-validated arguments.
 *
 * The backend's real RBAC model is permission-string based (e.g.
 * "commissions:schedules:create"), not a small fixed role enum, so
 * authorization throughout this server is done by checking membership in
 * `permissions`. `roles` is carried along for logging/display only.
 */
export interface UserSession {
  tenantId: string;
  userId: string;
  roles: string[];
  permissions: string[];
  accessToken: string;
}

export const sessionContext = new AsyncLocalStorage<UserSession>();

/**
 * Fetches the active session or throws. Every tool handler should call this
 * first rather than trusting any tenant/permission-shaped field an LLM
 * might have (incorrectly) included in its own arguments.
 */
export function requireSession(): UserSession {
  const session = sessionContext.getStore();
  if (!session) {
    throw new Error(
      "No active session context - this handler was invoked outside of sessionContext.run()."
    );
  }
  return session;
}

/** True if the session holds at least one of the given permission strings. */
export function hasAnyPermission(session: UserSession, permissions: string[]): boolean {
  return permissions.some((p) => session.permissions.includes(p));
}
