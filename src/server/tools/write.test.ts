import { describe, expect, it, vi, beforeEach } from "vitest";
import type { UserSession } from "../../auth/context.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { CommissionScheduleRecord } from "../../types/commissionSchedule.js";

let currentRecord: CommissionScheduleRecord | undefined;

const getMock = vi.fn(async (path: string) => {
  if (path.startsWith("/insurers/")) {
    return { status: 200, data: { data: { id: path.split("/").pop() } } };
  }
  if (path.startsWith("/commission-schedules/")) {
    if (!currentRecord) throw Object.assign(new Error("Backend responded 404"), { status: 404 });
    return { status: 200, data: { data: currentRecord } };
  }
  throw new Error(`Unexpected GET ${path} in test mock`);
});
const postMock = vi.fn(async () => ({ status: 201, data: { data: { id: "sch_new" } } }));
const putMock = vi.fn(async () => ({ status: 200, data: { data: { id: "sch_1", updated: true } } }));

vi.mock("../../backend/client.js", () => ({
  createBackendClient: () => ({ get: getMock, post: postMock, put: putMock, patch: vi.fn(), delete: vi.fn() }),
  backendStatus: (err: unknown) => (err as { status?: number } | undefined)?.status,
  describeBackendError: (err: unknown) => (err instanceof Error ? err.message : "Unknown backend error."),
  unwrapEnvelope: (raw: unknown) => ({ data: (raw as { data: unknown })?.data }),
}));

const { sessionContext } = await import("../../auth/context.js");
const { PERMISSIONS } = await import("./permissions.js");
const { WRITE_TOOLS } = await import("./write.js");

function getTool(name: string) {
  const tool = WRITE_TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool '${name}' not found in WRITE_TOOLS`);
  return tool;
}

function callTool(name: string, args: Record<string, unknown>, session: UserSession): Promise<CallToolResult> {
  const tool = getTool(name);
  return sessionContext.run(session, () => tool.handler(args, {} as never)) as Promise<CallToolResult>;
}

function textOf(result: CallToolResult): string {
  return result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
}

const FULL_ACCESS_SESSION: UserSession = {
  tenantId: "tenant_1",
  userId: "user_1",
  roles: ["tenant_admin"],
  permissions: [PERMISSIONS.SCHEDULES_VIEW, PERMISSIONS.SCHEDULES_CREATE, PERMISSIONS.SCHEDULES_UPDATE, PERMISSIONS.SCHEDULES_DELETE],
  accessToken: "test-token",
};

function baseVersion(rateValue = 15) {
  return {
    id: "ver_1",
    isActive: true,
    dimensionValues: [{ dimensionCode: "motor_cc_band", value: "125-250" }],
    rateComponents: [{ componentType: "BROKERAGE", basisType: "NET_PREMIUM", rateType: "PERCENTAGE", rateValue }],
  };
}

function baseRecord(overrides: Partial<CommissionScheduleRecord> = {}): CommissionScheduleRecord {
  return {
    id: "sch_1",
    tenantId: "tenant_1",
    productId: "prod_1",
    lobProfile: "MOTOR",
    name: "Two Wheeler Comp",
    updatedAt: "2026-01-01T00:00:00.000Z",
    insurers: [{ insurerId: "ins_1" }],
    versions: [baseVersion()],
    ...overrides,
  } as CommissionScheduleRecord;
}

const PROPOSED = {
  insurerIds: ["ins_1"],
  productId: "prod_1",
  planIds: ["plan_1"],
  lobProfile: "MOTOR",
  name: "Two Wheeler Comp",
  effectiveFrom: "2026-01-01",
  dimensionValues: [{ dimensionCode: "motor_cc_band", value: "125-250" }],
  rateComponents: [{ componentType: "BROKERAGE", basisType: "NET_PREMIUM", rateType: "PERCENTAGE", rateValue: 18 }],
};

beforeEach(() => {
  getMock.mockClear();
  postMock.mockClear();
  putMock.mockClear();
  currentRecord = baseRecord();
});

describe("write flow: create_new_schedule end to end", () => {
  it("diff -> create_change_request -> apply_change_request POSTs to the backend", async () => {
    currentRecord = undefined; // nothing exists yet

    const diffResult = await callTool(
      "diff_commission_schedule_change",
      { mode: "create_new_schedule", proposed: PROPOSED },
      FULL_ACCESS_SESSION
    );
    expect(diffResult.isError).toBeFalsy();
    const diff = JSON.parse(textOf(diffResult));
    expect(diff.baselineFingerprint).toBeUndefined();

    const crResult = await callTool(
      "create_change_request",
      { diffId: diff.diffId, sourceReference: "Test circular #1" },
      FULL_ACCESS_SESSION
    );
    expect(crResult.isError).toBeFalsy();
    const changeRequest = JSON.parse(textOf(crResult));
    expect(changeRequest.status).toBe("PENDING_CONFIRMATION");

    const applyResult = await callTool(
      "apply_change_request",
      { changeRequestId: changeRequest.changeRequestId, confirm: true },
      FULL_ACCESS_SESSION
    );
    expect(applyResult.isError).toBeFalsy();
    expect(postMock).toHaveBeenCalledTimes(1);
    expect(putMock).not.toHaveBeenCalled();
    const applied = JSON.parse(textOf(applyResult));
    expect(applied.status).toBe("APPLIED");
  });
});

describe("write flow: update_existing_schedule end to end", () => {
  it("diff -> create_change_request -> apply_change_request PUTs to the backend when nothing changed since", async () => {
    const diffResult = await callTool(
      "diff_commission_schedule_change",
      { mode: "update_existing_schedule", scheduleId: "sch_1", proposed: PROPOSED },
      FULL_ACCESS_SESSION
    );
    const diff = JSON.parse(textOf(diffResult));
    expect(diff.baselineFingerprint).toBeDefined();
    expect(diff.rateComponentChanges.find((r: { componentType: string }) => r.componentType === "BROKERAGE").change).toBe(
      "modified"
    );

    const crResult = await callTool(
      "create_change_request",
      { diffId: diff.diffId, sourceReference: "Test circular #2" },
      FULL_ACCESS_SESSION
    );
    const changeRequest = JSON.parse(textOf(crResult));

    const applyResult = await callTool(
      "apply_change_request",
      { changeRequestId: changeRequest.changeRequestId, confirm: true },
      FULL_ACCESS_SESSION
    );
    expect(applyResult.isError).toBeFalsy();
    expect(putMock).toHaveBeenCalledTimes(1);
    expect(postMock).not.toHaveBeenCalled();
  });

  it("accepts proposed.effectiveTo: null and PUTs null so the backend clears the end date", async () => {
    currentRecord = baseRecord({
      versions: [
        {
          ...baseVersion(),
          effectiveFrom: "2026-01-01",
          effectiveTo: "2099-12-31",
        },
      ],
    });

    // Keep rates identical so the only material clear is effectiveTo -> null.
    const proposed = {
      ...PROPOSED,
      effectiveTo: null,
      rateComponents: [{ componentType: "BROKERAGE", basisType: "NET_PREMIUM", rateType: "PERCENTAGE", rateValue: 15 }],
    };

    const diffResult = await callTool(
      "diff_commission_schedule_change",
      { mode: "update_existing_schedule", scheduleId: "sch_1", proposed },
      FULL_ACCESS_SESSION
    );
    expect(diffResult.isError).toBeFalsy();
    const diff = JSON.parse(textOf(diffResult));
    expect(diff.proposed.effectiveTo).toBeNull();
    expect(diff.scopeChanges).toContainEqual({
      field: "effectiveTo",
      oldValue: "2099-12-31",
      newValue: null,
    });

    const crResult = await callTool(
      "create_change_request",
      { diffId: diff.diffId, sourceReference: "Clear open-ended end date" },
      FULL_ACCESS_SESSION
    );
    const changeRequest = JSON.parse(textOf(crResult));

    const applyResult = await callTool(
      "apply_change_request",
      { changeRequestId: changeRequest.changeRequestId, confirm: true },
      FULL_ACCESS_SESSION
    );
    expect(applyResult.isError).toBeFalsy();
    expect(putMock).toHaveBeenCalledTimes(1);
    const putBody = putMock.mock.calls[0][1] as { effectiveTo: unknown };
    expect(putBody.effectiveTo).toBeNull();
  });

  it("refuses to apply a stale diff if the schedule changed after diff time (Task 3 guard)", async () => {
    const diffResult = await callTool(
      "diff_commission_schedule_change",
      { mode: "update_existing_schedule", scheduleId: "sch_1", proposed: PROPOSED },
      FULL_ACCESS_SESSION
    );
    const diff = JSON.parse(textOf(diffResult));

    const crResult = await callTool(
      "create_change_request",
      { diffId: diff.diffId, sourceReference: "Test circular #3" },
      FULL_ACCESS_SESSION
    );
    const changeRequest = JSON.parse(textOf(crResult));

    // Someone else changes the schedule's active rate between diff and apply.
    currentRecord = baseRecord({ versions: [baseVersion(999)] });

    const applyResult = await callTool(
      "apply_change_request",
      { changeRequestId: changeRequest.changeRequestId, confirm: true },
      FULL_ACCESS_SESSION
    );

    expect(applyResult.isError).toBe(true);
    expect(textOf(applyResult)).toMatch(/changed since this diff was computed/i);
    expect(putMock).not.toHaveBeenCalled();
  });
});

describe("write flow: reject_change_request / double-apply guard", () => {
  it("a rejected change request can never be applied afterwards", async () => {
    const diffResult = await callTool(
      "diff_commission_schedule_change",
      { mode: "update_existing_schedule", scheduleId: "sch_1", proposed: PROPOSED },
      FULL_ACCESS_SESSION
    );
    const diff = JSON.parse(textOf(diffResult));
    const crResult = await callTool(
      "create_change_request",
      { diffId: diff.diffId, sourceReference: "Test circular #4" },
      FULL_ACCESS_SESSION
    );
    const changeRequest = JSON.parse(textOf(crResult));

    const rejectResult = await callTool(
      "reject_change_request",
      { changeRequestId: changeRequest.changeRequestId, reason: "Rates look wrong, need re-verification." },
      FULL_ACCESS_SESSION
    );
    expect(rejectResult.isError).toBeFalsy();
    expect(JSON.parse(textOf(rejectResult)).status).toBe("REJECTED");

    const applyResult = await callTool(
      "apply_change_request",
      { changeRequestId: changeRequest.changeRequestId, confirm: true },
      FULL_ACCESS_SESSION
    );
    expect(applyResult.isError).toBe(true);
    expect(textOf(applyResult)).toMatch(/not PENDING_CONFIRMATION/);
    expect(putMock).not.toHaveBeenCalled();
  });

  it("an already-applied change request cannot be applied a second time", async () => {
    const diffResult = await callTool(
      "diff_commission_schedule_change",
      { mode: "update_existing_schedule", scheduleId: "sch_1", proposed: PROPOSED },
      FULL_ACCESS_SESSION
    );
    const diff = JSON.parse(textOf(diffResult));
    const crResult = await callTool(
      "create_change_request",
      { diffId: diff.diffId, sourceReference: "Test circular #5" },
      FULL_ACCESS_SESSION
    );
    const changeRequest = JSON.parse(textOf(crResult));

    const firstApply = await callTool(
      "apply_change_request",
      { changeRequestId: changeRequest.changeRequestId, confirm: true },
      FULL_ACCESS_SESSION
    );
    expect(firstApply.isError).toBeFalsy();

    const secondApply = await callTool(
      "apply_change_request",
      { changeRequestId: changeRequest.changeRequestId, confirm: true },
      FULL_ACCESS_SESSION
    );
    expect(secondApply.isError).toBe(true);
    expect(textOf(secondApply)).toMatch(/not PENDING_CONFIRMATION/);
    expect(putMock).toHaveBeenCalledTimes(1);
  });
});
