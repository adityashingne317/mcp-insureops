import { z } from "zod";
import { backendStatus, describeBackendError, createBackendClient, unwrapEnvelope } from "../../backend/client.js";
import { CommissionScheduleInput, CommissionScheduleRecord, DiffMode } from "../../types/commissionSchedule.js";
import { assertPermission, assertPermissionAndTenant, defineTool, type ToolDefinition } from "./registry.js";
import { withToolErrorHandling, jsonResult } from "./responses.js";
import { PERMISSIONS } from "./permissions.js";
import { computeScheduleDiff, computeBaselineFingerprint } from "./scheduleDiff.js";
import { saveDiff, takeDiff, createChangeRequest, getChangeRequest, setChangeRequestStatus } from "./diffStore.js";

const WRITE_PERMS = [PERMISSIONS.SCHEDULES_CREATE, PERMISSIONS.SCHEDULES_UPDATE] as const;

async function fetchScheduleOrUndefined(
  accessToken: string,
  scheduleId: string
): Promise<CommissionScheduleRecord | undefined> {
  const client = createBackendClient(accessToken);
  try {
    const { data } = await client.get(`/commission-schedules/${scheduleId}`);
    return unwrapEnvelope<CommissionScheduleRecord>(data).data;
  } catch (err) {
    if (backendStatus(err) === 404) return undefined;
    throw new Error(describeBackendError(err));
  }
}

const diffCommissionScheduleChange = defineTool({
  name: "diff_commission_schedule_change",
  description:
    "Compute a diff between what's currently active on a commission schedule and a proposed new/updated schedule (typically extracted from an insurer's circular/rate card/PDF). This is read-adjacent and side-effect-free - nothing is mutated. NOTE: this backend has no diff endpoint of its own, so this diff is computed by this MCP server itself from a fresh GET plus the proposal you supply (see SPEC.md). Returns { diffId, scopeChanges, dimensionValueChanges, rateComponentChanges }; diffId is a short-lived reference to this exact comparison, consumed by create_change_request. Always show this diff to the user before proposing create_change_request. Use mode='create_new_schedule' for a schedule that doesn't exist yet (omit scheduleId), or mode='update_existing_schedule' with scheduleId for changes to an existing one.",
  inputSchema: {
    mode: DiffMode,
    scheduleId: z.string().optional().describe("Required when mode='update_existing_schedule'."),
    proposed: CommissionScheduleInput.describe(
      "The full desired end-state of the schedule (not a partial patch) - normalized into structured form by the caller (the LLM), not yet trusted as the diff."
    ),
  },
  requiredPermissions: [...WRITE_PERMS],
  handler: async ({ mode, scheduleId, proposed }) =>
    withToolErrorHandling(async () => {
      if (mode === "update_existing_schedule" && !scheduleId) {
        throw new Error("scheduleId is required when mode='update_existing_schedule'.");
      }
      const requiredPerm = mode === "create_new_schedule" ? PERMISSIONS.SCHEDULES_CREATE : PERMISSIONS.SCHEDULES_UPDATE;
      const session = await assertPermissionAndTenant("diff_commission_schedule_change", [requiredPerm], {
        insurerIds: proposed.insurerIds,
      });

      const current = scheduleId ? await fetchScheduleOrUndefined(session.accessToken, scheduleId) : undefined;
      if (mode === "update_existing_schedule" && !current) {
        throw new Error(`Schedule '${scheduleId}' was not found for this tenant.`);
      }

      const diff = computeScheduleDiff(mode, current, proposed);
      saveDiff(diff, session.tenantId);
      return jsonResult(diff);
    }),
});

const createChangeRequestTool = defineTool({
  name: "create_change_request",
  description:
    "Bundle a previously computed diff into one reviewable, PENDING_CONFIRMATION change request. This does NOT apply anything - it only stages the batch for explicit approval via apply_change_request. Fails if the referenced diffId has expired or was already consumed.",
  inputSchema: {
    diffId: z.string().describe("From a prior diff_commission_schedule_change call."),
    sourceReference: z.string().describe("e.g. 'Insurer circular #4521, received 2026-07-20' - required for audit trail."),
    notes: z.string().optional(),
  },
  requiredPermissions: [...WRITE_PERMS],
  handler: async ({ diffId, sourceReference, notes }) =>
    withToolErrorHandling(async () => {
      const session = assertPermission("create_change_request", [...WRITE_PERMS]);
      const diff = takeDiff(diffId, session.tenantId);
      if (!diff) {
        throw new Error(
          `diffId '${diffId}' is no longer valid (expired or already consumed). Re-run diff_commission_schedule_change to get a fresh comparison.`
        );
      }
      const changeRequest = createChangeRequest({
        diff,
        tenantId: session.tenantId,
        createdBy: session.userId,
        sourceReference,
        notes,
      });
      return jsonResult(changeRequest);
    }),
});

const applyChangeRequestTool = defineTool({
  name: "apply_change_request",
  description:
    "Apply a PENDING_CONFIRMATION change request by writing it to the backend (POST for a new schedule, PUT for an update to an existing one). Requires the literal confirm: true field so this call is unambiguous in the transcript - never invoke this without the user having explicitly approved the diff shown to them. Fails closed if the change request has already been applied/rejected, if the caller's permission check fails, or (for updates) if the schedule changed since the diff was computed - re-run diff_commission_schedule_change and create_change_request in that case.",
  inputSchema: {
    changeRequestId: z.string(),
    confirm: z.literal(true).describe("Must be exactly `true`. Only set this after the user has explicitly approved the shown diff."),
  },
  requiredPermissions: [...WRITE_PERMS],
  handler: async ({ changeRequestId, confirm }) =>
    withToolErrorHandling(async () => {
      // Re-check permission even though this tool is already filtered out of
      // tools/list for sessions without write permissions - the "fails
      // closed even if it somehow got called" requirement.
      const session = assertPermission("apply_change_request", [...WRITE_PERMS]);
      if (confirm !== true) {
        throw new Error("apply_change_request requires confirm: true.");
      }

      const entry = getChangeRequest(changeRequestId, session.tenantId);
      if (!entry) {
        throw new Error(`Change request '${changeRequestId}' was not found for this tenant.`);
      }
      if (entry.changeRequest.status !== "PENDING_CONFIRMATION") {
        throw new Error(
          `Change request '${changeRequestId}' is '${entry.changeRequest.status}', not PENDING_CONFIRMATION - it cannot be applied again.`
        );
      }

      const requiredPerm =
        entry.diff.mode === "create_new_schedule" ? PERMISSIONS.SCHEDULES_CREATE : PERMISSIONS.SCHEDULES_UPDATE;
      if (!session.permissions.includes(requiredPerm)) {
        throw new Error(`Applying a '${entry.diff.mode}' change request requires the '${requiredPerm}' permission.`);
      }

      const client = createBackendClient(session.accessToken);
      const { proposed } = entry.diff;

      if (entry.diff.mode === "update_existing_schedule") {
        // Stale-diff guard: re-fetch and re-fingerprint the schedule right
        // before writing. If it doesn't match what diff_commission_schedule_change
        // saw, someone else changed it in the meantime - refuse rather than
        // silently overwrite (see Task 3 / SPEC.md).
        const freshCurrent = await fetchScheduleOrUndefined(session.accessToken, entry.diff.scheduleId!);
        const freshFingerprint = computeBaselineFingerprint(freshCurrent);
        if (freshFingerprint !== entry.diff.baselineFingerprint) {
          throw new Error(
            `Schedule '${entry.diff.scheduleId}' has changed since this diff was computed (or was deleted) - refusing to apply a stale change request. Re-run diff_commission_schedule_change and create_change_request against the current state, then retry apply_change_request.`
          );
        }
      }

      try {
        let data: unknown;
        if (entry.diff.mode === "create_new_schedule") {
          const response = await client.post("/commission-schedules", proposed);
          data = response.data;
        } else {
          const { productId: _productId, countryId: _countryId, lobProfile: _lobProfile, ...updatePayload } = proposed;
          const response = await client.put(`/commission-schedules/${entry.diff.scheduleId}`, updatePayload);
          data = response.data;
        }
        setChangeRequestStatus(changeRequestId, session.tenantId, "APPLIED");
        return jsonResult({ backendResult: data, changeRequestId, status: "APPLIED" });
      } catch (err) {
        throw new Error(describeBackendError(err));
      }
    }),
});

const rejectChangeRequestTool = defineTool({
  name: "reject_change_request",
  description: "Reject a PENDING_CONFIRMATION change request without applying it, recording a reason for the audit trail.",
  inputSchema: {
    changeRequestId: z.string(),
    reason: z.string(),
  },
  requiredPermissions: [...WRITE_PERMS],
  handler: async ({ changeRequestId, reason }) =>
    withToolErrorHandling(async () => {
      const session = assertPermission("reject_change_request", [...WRITE_PERMS]);
      const entry = getChangeRequest(changeRequestId, session.tenantId);
      if (!entry) {
        throw new Error(`Change request '${changeRequestId}' was not found for this tenant.`);
      }
      if (entry.changeRequest.status !== "PENDING_CONFIRMATION") {
        throw new Error(`Change request '${changeRequestId}' is '${entry.changeRequest.status}', not PENDING_CONFIRMATION.`);
      }
      entry.changeRequest.notes = [entry.changeRequest.notes, `Rejected: ${reason}`].filter(Boolean).join(" | ");
      const updated = setChangeRequestStatus(changeRequestId, session.tenantId, "REJECTED");
      return jsonResult(updated);
    }),
});

const activateScheduleVersion = defineTool({
  name: "activate_schedule_version",
  description:
    "Make a specific existing version of a commission schedule the active one (POST .../versions/{versionId}/activate). Use this for versions already created via apply_change_request that were left in draft/inactive, or to roll back to a previously-active version. Requires confirm: true.",
  inputSchema: {
    scheduleId: z.string(),
    versionId: z.string(),
    confirm: z.literal(true),
  },
  requiredPermissions: [PERMISSIONS.SCHEDULES_UPDATE],
  handler: async ({ scheduleId, versionId, confirm }) =>
    withToolErrorHandling(async () => {
      const session = assertPermission("activate_schedule_version", [PERMISSIONS.SCHEDULES_UPDATE]);
      if (confirm !== true) {
        throw new Error("activate_schedule_version requires confirm: true.");
      }
      const client = createBackendClient(session.accessToken);
      try {
        const { data } = await client.post(`/commission-schedules/${scheduleId}/versions/${versionId}/activate`);
        return jsonResult(data);
      } catch (err) {
        throw new Error(describeBackendError(err));
      }
    }),
});

const deactivateCommissionSchedule = defineTool({
  name: "deactivate_commission_schedule",
  description:
    "Retire a commission schedule. VERIFIED LIVE BEHAVIOR (Task 1): this backend has no 'flip status to INACTIVE but stay visible' operation on an existing active version - PUT rejects a body whose dimension/rule criteria and effective period exactly match the currently-active version as a 409 duplicate-overlap conflict, whether or not isActive/status is included. The only working retire path is DELETE /commission-schedules/{id}, a soft delete (deletedAt is set, the row and its version history are preserved for audit, never physically removed) that then excludes the schedule from list_commission_schedules and get_commission_schedule going forward - there is no 'undo' tool for this in this server. Requires confirm: true.",
  inputSchema: {
    scheduleId: z.string(),
    sourceReference: z.string().describe("Reason for retiring this schedule, for the audit trail (the backend has no field for this - it's not sent in the request)."),
    confirm: z.literal(true),
  },
  requiredPermissions: [PERMISSIONS.SCHEDULES_DELETE],
  handler: async ({ scheduleId, sourceReference, confirm }) =>
    withToolErrorHandling(async () => {
      const session = assertPermission("deactivate_commission_schedule", [PERMISSIONS.SCHEDULES_DELETE]);
      if (confirm !== true) {
        throw new Error("deactivate_commission_schedule requires confirm: true.");
      }
      const client = createBackendClient(session.accessToken);
      try {
        await client.delete(`/commission-schedules/${scheduleId}`);
        return jsonResult({ scheduleId, status: "DELETED", sourceReference });
      } catch (err) {
        throw new Error(describeBackendError(err));
      }
    }),
});

export const WRITE_TOOLS: ToolDefinition[] = [
  diffCommissionScheduleChange,
  createChangeRequestTool,
  applyChangeRequestTool,
  rejectChangeRequestTool,
  activateScheduleVersion,
  deactivateCommissionSchedule,
];
