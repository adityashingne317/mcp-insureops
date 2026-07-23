/**
 * Backend permission strings this server cares about, taken verbatim from
 * the real API's own RBAC keys (see GET /auth/me/permissions). Centralized
 * here so tool definitions reference one canonical constant instead of
 * repeating string literals that could drift or typo.
 */
export const PERMISSIONS = {
  INSURER_VIEW: "settings:insurer:view",
  PRODUCTS_VIEW: "settings:products:view",
  PLANS_VIEW: "settings:plans:view",
  SCHEDULES_VIEW: "commissions:schedules:view",
  SCHEDULES_CREATE: "commissions:schedules:create",
  SCHEDULES_UPDATE: "commissions:schedules:update",
  SCHEDULES_DELETE: "commissions:schedules:delete",
} as const;

export const READ_PERMISSIONS = [PERMISSIONS.SCHEDULES_VIEW] as const;
export const WRITE_PERMISSIONS = [
  PERMISSIONS.SCHEDULES_CREATE,
  PERMISSIONS.SCHEDULES_UPDATE,
  PERMISSIONS.SCHEDULES_DELETE,
] as const;
