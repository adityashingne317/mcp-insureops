import { describe, expect, it } from "vitest";
import { computeBaselineFingerprint, computeScheduleDiff } from "./scheduleDiff.js";
import type { CommissionScheduleInput, CommissionScheduleRecord } from "../../types/commissionSchedule.js";

function makeProposed(overrides: Partial<CommissionScheduleInput> = {}): CommissionScheduleInput {
  return {
    insurerIds: ["ins_1"],
    productId: "prod_1",
    planIds: ["plan_1"],
    lobProfile: "MOTOR",
    name: "Two Wheeler Comp",
    effectiveFrom: "2026-01-01",
    dimensionValues: [{ dimensionCode: "motor_cc_band", value: "125-250" }],
    rateComponents: [{ componentType: "BROKERAGE", basisType: "NET_PREMIUM", rateType: "PERCENTAGE", rateValue: 15 }],
    ...overrides,
  };
}

function makeCurrentRecord(overrides: Partial<CommissionScheduleRecord> = {}): CommissionScheduleRecord {
  return {
    id: "sch_1",
    tenantId: "tenant_1",
    productId: "prod_1",
    lobProfile: "MOTOR",
    name: "Two Wheeler Comp",
    updatedAt: "2026-01-01T00:00:00.000Z",
    insurers: [{ insurerId: "ins_1" }],
    plans: [{ planId: "plan_1" }],
    versions: [
      {
        id: "ver_1",
        isActive: true,
        effectiveFrom: "2026-01-01",
        dimensionValues: [{ dimensionCode: "motor_cc_band", value: "125-250" }],
        rateComponents: [{ componentType: "BROKERAGE", basisType: "NET_PREMIUM", rateType: "PERCENTAGE", rateValue: 15 }],
      },
    ],
    ...overrides,
  } as CommissionScheduleRecord;
}

describe("computeScheduleDiff", () => {
  it("mode=create_new_schedule: everything shows as added, no baseline fingerprint", () => {
    const diff = computeScheduleDiff("create_new_schedule", undefined, makeProposed());

    expect(diff.scheduleId).toBeUndefined();
    expect(diff.baselineFingerprint).toBeUndefined();
    expect(diff.dimensionValueChanges).toEqual([{ dimensionCode: "motor_cc_band", change: "added", newValue: "125-250" }]);
    expect(diff.rateComponentChanges).toEqual([
      { componentType: "BROKERAGE", basisType: "NET_PREMIUM", addonDefinitionId: undefined, change: "added", newRateType: "PERCENTAGE", newRateValue: 15 },
    ]);
  });

  it("mode=update_existing_schedule: identical proposal yields no changes and a stable fingerprint", () => {
    const current = makeCurrentRecord();
    const diff = computeScheduleDiff("update_existing_schedule", current, makeProposed());

    expect(diff.scheduleId).toBe("sch_1");
    expect(diff.scopeChanges).toEqual([]);
    expect(diff.dimensionValueChanges).toEqual([
      { dimensionCode: "motor_cc_band", change: "unchanged", oldValue: "125-250", newValue: "125-250" },
    ]);
    expect(diff.rateComponentChanges[0].change).toBe("unchanged");
    expect(diff.baselineFingerprint).toBeDefined();
  });

  it("detects a modified rate component and an added dimension value", () => {
    const current = makeCurrentRecord();
    const proposed = makeProposed({
      dimensionValues: [
        { dimensionCode: "motor_cc_band", value: "125-250" },
        { dimensionCode: "vehicle_age_band", value: "0-1" },
      ],
      rateComponents: [{ componentType: "BROKERAGE", basisType: "NET_PREMIUM", rateType: "PERCENTAGE", rateValue: 18 }],
    });

    const diff = computeScheduleDiff("update_existing_schedule", current, proposed);

    const addedDim = diff.dimensionValueChanges.find((d) => d.dimensionCode === "vehicle_age_band");
    expect(addedDim).toEqual({ dimensionCode: "vehicle_age_band", change: "added", newValue: "0-1" });

    const modifiedRate = diff.rateComponentChanges.find((r) => r.componentType === "BROKERAGE");
    expect(modifiedRate?.change).toBe("modified");
    expect(modifiedRate?.oldRateValue).toBe(15);
    expect(modifiedRate?.newRateValue).toBe(18);
  });

  it("detects a removed rate component and a removed dimension value", () => {
    const current = makeCurrentRecord({
      versions: [
        {
          id: "ver_1",
          isActive: true,
          dimensionValues: [
            { dimensionCode: "motor_cc_band", value: "125-250" },
            { dimensionCode: "vehicle_age_band", value: "0-1" },
          ],
          rateComponents: [
            { componentType: "BROKERAGE", basisType: "NET_PREMIUM", rateType: "PERCENTAGE", rateValue: 15 },
            { componentType: "REWARD", basisType: "NET_PREMIUM", rateType: "PERCENTAGE", rateValue: 2 },
          ],
        },
      ],
    });
    const proposed = makeProposed();

    const diff = computeScheduleDiff("update_existing_schedule", current, proposed);

    expect(diff.dimensionValueChanges.find((d) => d.dimensionCode === "vehicle_age_band")?.change).toBe("removed");
    expect(diff.rateComponentChanges.find((r) => r.componentType === "REWARD")?.change).toBe("removed");
  });

  it("detects scope changes (name, priority, insurerIds set-equality)", () => {
    const current = makeCurrentRecord({ name: "Old Name", priority: 1 });
    const proposed = makeProposed({ name: "New Name", priority: 2, insurerIds: ["ins_1", "ins_2"] });

    const diff = computeScheduleDiff("update_existing_schedule", current, proposed);

    expect(diff.scopeChanges).toEqual(
      expect.arrayContaining([
        { field: "name", oldValue: "Old Name", newValue: "New Name" },
        { field: "priority", oldValue: 1, newValue: 2 },
        { field: "insurerIds", oldValue: ["ins_1"], newValue: ["ins_1", "ins_2"] },
      ])
    );
  });

  it("insurerIds/planIds diff is order-insensitive (set equality, not array equality)", () => {
    const current = makeCurrentRecord({ insurers: [{ insurerId: "ins_2" }, { insurerId: "ins_1" }] });
    const proposed = makeProposed({ insurerIds: ["ins_1", "ins_2"] });

    const diff = computeScheduleDiff("update_existing_schedule", current, proposed);

    expect(diff.scopeChanges.find((c) => c.field === "insurerIds")).toBeUndefined();
  });
});

describe("computeBaselineFingerprint", () => {
  it("is undefined when there is no current record", () => {
    expect(computeBaselineFingerprint(undefined)).toBeUndefined();
  });

  it("is stable for an unchanged record", () => {
    const a = computeBaselineFingerprint(makeCurrentRecord());
    const b = computeBaselineFingerprint(makeCurrentRecord());
    expect(a).toBeDefined();
    expect(a).toBe(b);
  });

  it("changes when the active version's rateComponents change", () => {
    const original = computeBaselineFingerprint(makeCurrentRecord());
    const changed = computeBaselineFingerprint(
      makeCurrentRecord({
        versions: [
          {
            id: "ver_1",
            isActive: true,
            dimensionValues: [{ dimensionCode: "motor_cc_band", value: "125-250" }],
            rateComponents: [{ componentType: "BROKERAGE", basisType: "NET_PREMIUM", rateType: "PERCENTAGE", rateValue: 99 }],
          },
        ],
      })
    );
    expect(changed).not.toBe(original);
  });

  it("changes when updatedAt changes even if version content looks the same", () => {
    const original = computeBaselineFingerprint(makeCurrentRecord({ updatedAt: "2026-01-01T00:00:00.000Z" }));
    const changed = computeBaselineFingerprint(makeCurrentRecord({ updatedAt: "2026-02-01T00:00:00.000Z" }));
    expect(changed).not.toBe(original);
  });
});
