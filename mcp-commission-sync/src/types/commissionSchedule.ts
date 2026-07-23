import { z } from "zod";

/**
 * One "rule criteria" entry (called a dimension by the backend). Valid
 * `dimensionCode`s are dynamic per tenant/plan - discover them with
 * list_schedule_dimensions rather than hardcoding an enum here. Either
 * `value` (exact match) or the numeric range pair is set, never both.
 */
export const DimensionValueInput = z.object({
  dimensionCode: z.string().min(1),
  value: z.union([z.string(), z.number()]).optional(),
  minNumericValue: z.number().optional(),
  maxNumericValue: z.number().optional(),
});
export type DimensionValueInput = z.infer<typeof DimensionValueInput>;

/**
 * One rate table row. `basisType` is dynamic per `lobProfile` - discover
 * valid values with list_schedule_basis_types before proposing a rate
 * component. `componentType` (e.g. "BROKERAGE") and `rateType` (e.g.
 * "PERCENTAGE") are likewise backend-defined, tenant-configurable strings.
 */
export const RateComponentInput = z.object({
  componentType: z.string().min(1),
  basisType: z.string().min(1),
  rateType: z.string().min(1),
  rateValue: z.number(),
  addonDefinitionId: z.string().optional(),
});
export type RateComponentInput = z.infer<typeof RateComponentInput>;

export const MatchConditionsInput = z.object({
  logic: z.enum(["AND", "OR"]),
  conditions: z.array(z.record(z.string(), z.unknown())),
});
export type MatchConditionsInput = z.infer<typeof MatchConditionsInput>;

/**
 * The full proposed shape of a commission schedule - matches the real
 * backend's POST /commission-schedules body. Used both for genuinely new
 * schedules and, for updates, as "the fields we want the schedule to end
 * up with" (diff_commission_schedule_change compares this against
 * whatever currently exists).
 */
export const CommissionScheduleInput = z.object({
  insurerIds: z.array(z.string()).min(1),
  productId: z.string().min(1),
  // Confirmed required (non-empty) via live verification against the dev
  // backend (Task 1) - POST /commission-schedules 400s with "planIds must
  // contain at least 1 elements" if omitted or empty. Not optional despite
  // earlier assumption. Use list_plans (filtered by productId) to find one.
  planIds: z.array(z.string()).min(1),
  addonDefinitionIds: z.array(z.string()).optional(),
  countryId: z.string().optional(),
  lobProfile: z.string().min(1),
  name: z.string().min(1),
  code: z.string().optional(),
  priority: z.number().optional(),
  effectiveFrom: z.string(), // ISO date
  effectiveTo: z.string().optional(),
  isActive: z.boolean().optional(),
  dimensionValues: z.array(DimensionValueInput).default([]),
  rateComponents: z.array(RateComponentInput).min(1),
  matchConditions: MatchConditionsInput.optional(),
});
export type CommissionScheduleInput = z.infer<typeof CommissionScheduleInput>;

export const ScheduleStatus = z.enum(["DRAFT", "ACTIVE", "INACTIVE"]);
export type ScheduleStatus = z.infer<typeof ScheduleStatus>;

/**
 * A schedule as returned by the backend (GET /commission-schedules[/{id}]).
 * Kept intentionally loose (passthrough-ish nested shapes) - this server
 * only reads specific fields back out for diffing/display, it never
 * re-validates the backend's own response shape strictly.
 */
export const CommissionScheduleRecord = z
  .object({
    id: z.string(),
    tenantId: z.string(),
    countryId: z.string().nullable().optional(),
    productId: z.string(),
    lobProfile: z.string(),
    code: z.string().optional(),
    name: z.string(),
    status: z.string().optional(),
    priority: z.number().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
    deletedAt: z.string().nullable().optional(),
    insurers: z.array(z.unknown()).optional(),
    plans: z.array(z.unknown()).optional(),
    addons: z.array(z.unknown()).optional(),
    versions: z
      .array(
        z.object({
          id: z.string(),
          version: z.number().optional(),
          effectiveFrom: z.string().optional(),
          effectiveTo: z.string().nullable().optional(),
          isActive: z.boolean().optional(),
          matchConditions: z.unknown().nullable().optional(),
          dimensionValues: z.array(z.record(z.string(), z.unknown())).optional(),
          rateComponents: z.array(z.record(z.string(), z.unknown())).optional(),
        })
      )
      .optional(),
  })
  .passthrough();
export type CommissionScheduleRecord = z.infer<typeof CommissionScheduleRecord>;

/**
 * Server-computed (by this MCP server, not the backend - see SPEC.md for
 * why) comparison between what's currently active on a schedule and a
 * proposed CommissionScheduleInput. `diffId` is a short-lived reference to
 * this exact comparison, consumed by create_change_request.
 */
export const FieldDiffEntry = z.object({
  field: z.string(),
  oldValue: z.unknown(),
  newValue: z.unknown(),
});
export type FieldDiffEntry = z.infer<typeof FieldDiffEntry>;

export const DimensionValueDiffEntry = z.object({
  dimensionCode: z.string(),
  change: z.enum(["added", "removed", "modified", "unchanged"]),
  oldValue: z.unknown().optional(),
  newValue: z.unknown().optional(),
});
export type DimensionValueDiffEntry = z.infer<typeof DimensionValueDiffEntry>;

export const RateComponentDiffEntry = z.object({
  componentType: z.string(),
  basisType: z.string(),
  addonDefinitionId: z.string().optional(),
  change: z.enum(["added", "removed", "modified", "unchanged"]),
  oldRateType: z.string().optional(),
  newRateType: z.string().optional(),
  oldRateValue: z.number().optional(),
  newRateValue: z.number().optional(),
});
export type RateComponentDiffEntry = z.infer<typeof RateComponentDiffEntry>;

export const DiffMode = z.enum(["create_new_schedule", "update_existing_schedule"]);
export type DiffMode = z.infer<typeof DiffMode>;

export const DiffResult = z.object({
  diffId: z.string(),
  mode: DiffMode,
  scheduleId: z.string().optional(),
  scopeChanges: z.array(FieldDiffEntry),
  dimensionValueChanges: z.array(DimensionValueDiffEntry),
  rateComponentChanges: z.array(RateComponentDiffEntry),
  proposed: CommissionScheduleInput,
  expiresAt: z.string(),
  /**
   * Hash of the schedule's active version (updatedAt/versionId/dimensionValues/
   * rateComponents) as it existed at diff time. Undefined for
   * mode='create_new_schedule' (no baseline to pin). apply_change_request
   * re-fetches the schedule and recomputes this before writing for
   * mode='update_existing_schedule' - a mismatch means the schedule changed
   * since this diff was computed, and the apply is refused. See
   * scheduleDiff.ts#computeBaselineFingerprint.
   */
  baselineFingerprint: z.string().optional(),
});
export type DiffResult = z.infer<typeof DiffResult>;

export const ChangeRequestStatus = z.enum(["PENDING_CONFIRMATION", "APPLIED", "REJECTED", "EXPIRED"]);
export type ChangeRequestStatus = z.infer<typeof ChangeRequestStatus>;

export const ChangeRequest = z.object({
  changeRequestId: z.string(),
  diffId: z.string(),
  mode: DiffMode,
  scheduleId: z.string().optional(),
  status: ChangeRequestStatus,
  sourceReference: z.string(),
  notes: z.string().optional(),
  createdAt: z.string(),
  createdBy: z.string(),
  tenantId: z.string(),
});
export type ChangeRequest = z.infer<typeof ChangeRequest>;
