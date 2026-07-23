import { z } from "zod";
import { requireSession } from "../../auth/context.js";
import { createBackendClient, describeBackendError } from "../../backend/client.js";
import { defineTool, type ToolDefinition } from "./registry.js";
import { withToolErrorHandling, jsonResult } from "./responses.js";
import { PERMISSIONS } from "./permissions.js";
import { listChangeRequests as listStoredChangeRequests, getChangeRequest as getStoredChangeRequest } from "./diffStore.js";
import { ChangeRequestStatus } from "../../types/commissionSchedule.js";

const listInsurers = defineTool({
  name: "list_insurers",
  description: "List the insurers configured for the caller's tenant (paginated).",
  inputSchema: {
    page: z.number().int().positive().optional(),
    limit: z.number().int().positive().max(100).optional(),
    search: z.string().optional(),
  },
  requiredPermissions: [PERMISSIONS.INSURER_VIEW],
  handler: async ({ page, limit, search }) =>
    withToolErrorHandling(async () => {
      const session = requireSession();
      const client = createBackendClient(session.accessToken);
      try {
        const { data } = await client.get("/insurers", { params: { page, limit, search } });
        return jsonResult(data);
      } catch (err) {
        throw new Error(describeBackendError(err));
      }
    }),
});

const listProducts = defineTool({
  name: "list_products",
  description: "List the insurance products available for the caller's tenant (paginated).",
  inputSchema: {
    page: z.number().int().positive().optional(),
    limit: z.number().int().positive().max(100).optional(),
    search: z.string().optional(),
  },
  requiredPermissions: [PERMISSIONS.PRODUCTS_VIEW],
  handler: async ({ page, limit, search }) =>
    withToolErrorHandling(async () => {
      const session = requireSession();
      const client = createBackendClient(session.accessToken);
      try {
        const { data } = await client.get("/products", { params: { page, limit, search } });
        return jsonResult(data);
      } catch (err) {
        throw new Error(describeBackendError(err));
      }
    }),
});

const listPlans = defineTool({
  name: "list_plans",
  description: "List plans for a given product (paginated).",
  inputSchema: {
    productId: z.string().optional(),
    page: z.number().int().positive().optional(),
    limit: z.number().int().positive().max(100).optional(),
  },
  requiredPermissions: [PERMISSIONS.PLANS_VIEW],
  handler: async ({ productId, page, limit }) =>
    withToolErrorHandling(async () => {
      const session = requireSession();
      const client = createBackendClient(session.accessToken);
      try {
        const { data } = await client.get("/plans", { params: { productId, page, limit } });
        return jsonResult(data);
      } catch (err) {
        throw new Error(describeBackendError(err));
      }
    }),
});

const listCommissionSchedules = defineTool({
  name: "list_commission_schedules",
  description:
    "List commission schedules currently stored in the application, optionally filtered by product/insurer/lobProfile/status. Each schedule includes its version history with dimensionValues (rule criteria) and rateComponents (rate table). This is the source of truth to compare an insurer's new document against before proposing any change.",
  inputSchema: {
    productId: z.string().optional(),
    insurerId: z.string().optional(),
    lobProfile: z.string().optional(),
    status: z.enum(["DRAFT", "ACTIVE", "INACTIVE"]).optional(),
  },
  requiredPermissions: [PERMISSIONS.SCHEDULES_VIEW],
  handler: async ({ productId, insurerId, lobProfile, status }) =>
    withToolErrorHandling(async () => {
      const session = requireSession();
      const client = createBackendClient(session.accessToken);
      try {
        const { data } = await client.get("/commission-schedules", {
          params: { productId, insurerId, lobProfile, status },
        });
        return jsonResult(data);
      } catch (err) {
        throw new Error(describeBackendError(err));
      }
    }),
});

const getCommissionSchedule = defineTool({
  name: "get_commission_schedule",
  description: "Fetch a single commission schedule's full detail, including all its versions.",
  inputSchema: {
    scheduleId: z.string(),
  },
  requiredPermissions: [PERMISSIONS.SCHEDULES_VIEW],
  handler: async ({ scheduleId }) =>
    withToolErrorHandling(async () => {
      const session = requireSession();
      const client = createBackendClient(session.accessToken);
      try {
        const { data } = await client.get(`/commission-schedules/${scheduleId}`);
        return jsonResult(data);
      } catch (err) {
        throw new Error(describeBackendError(err));
      }
    }),
});

const listScheduleDimensions = defineTool({
  name: "list_schedule_dimensions",
  description:
    "List the valid 'rule criteria' dimension codes (e.g. motor_cc_band) available for building dimensionValues on a commission schedule version. Always check this before proposing dimensionValues so dimensionCode values aren't invented.",
  inputSchema: {},
  requiredPermissions: [PERMISSIONS.SCHEDULES_VIEW],
  handler: async () =>
    withToolErrorHandling(async () => {
      const session = requireSession();
      const client = createBackendClient(session.accessToken);
      try {
        const { data } = await client.get("/commission-schedules/registry/dimensions");
        return jsonResult(data);
      } catch (err) {
        throw new Error(describeBackendError(err));
      }
    }),
});

const listScheduleBasisTypes = defineTool({
  name: "list_schedule_basis_types",
  description:
    "List the valid rate 'basisType' values for a given lobProfile (e.g. MOTOR_OD, NET_PREMIUM for MOTOR). Basis types are line-of-business specific - always check this before proposing rateComponents.",
  inputSchema: {
    lobProfile: z.string().describe("e.g. MOTOR, HEALTH."),
  },
  requiredPermissions: [PERMISSIONS.SCHEDULES_VIEW],
  handler: async ({ lobProfile }) =>
    withToolErrorHandling(async () => {
      const session = requireSession();
      const client = createBackendClient(session.accessToken);
      try {
        const { data } = await client.get("/commission-schedules/registry/basis-types", {
          params: { lobProfile },
        });
        return jsonResult(data);
      } catch (err) {
        throw new Error(describeBackendError(err));
      }
    }),
});

const listChangeRequests = defineTool({
  name: "list_change_requests",
  description:
    "List commission schedule change requests staged by this server for the caller's tenant, optionally filtered by status. These are tracked by this MCP server itself (the backend has no equivalent concept), persisted locally, and survive a server restart.",
  inputSchema: {
    status: ChangeRequestStatus.optional(),
  },
  requiredPermissions: [PERMISSIONS.SCHEDULES_VIEW],
  handler: async ({ status }) =>
    withToolErrorHandling(async () => {
      const session = requireSession();
      const items = listStoredChangeRequests(session.tenantId, { status });
      return jsonResult({ items });
    }),
});

const getChangeRequest = defineTool({
  name: "get_change_request",
  description: "Fetch a single change request staged by this server, including the diff it was created from.",
  inputSchema: {
    changeRequestId: z.string(),
  },
  requiredPermissions: [PERMISSIONS.SCHEDULES_VIEW],
  handler: async ({ changeRequestId }) =>
    withToolErrorHandling(async () => {
      const session = requireSession();
      const entry = getStoredChangeRequest(changeRequestId, session.tenantId);
      if (!entry) {
        throw new Error(`Change request '${changeRequestId}' was not found for this tenant (or has expired).`);
      }
      return jsonResult(entry);
    }),
});

export const READ_TOOLS: ToolDefinition[] = [
  listInsurers,
  listProducts,
  listPlans,
  listCommissionSchedules,
  getCommissionSchedule,
  listScheduleDimensions,
  listScheduleBasisTypes,
  listChangeRequests,
  getChangeRequest,
];
