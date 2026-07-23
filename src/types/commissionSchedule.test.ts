import { describe, expect, it } from "vitest";
import { CommissionScheduleInput } from "./commissionSchedule.js";

const BASE = {
  insurerIds: ["ins_1"],
  productId: "prod_1",
  planIds: ["plan_1"],
  lobProfile: "MOTOR",
  name: "Two Wheeler Comp",
  effectiveFrom: "2026-01-01",
  dimensionValues: [{ dimensionCode: "motor_cc_band", value: "125-250" }],
  rateComponents: [{ componentType: "BROKERAGE", basisType: "NET_PREMIUM", rateType: "PERCENTAGE", rateValue: 15 }],
};

describe("CommissionScheduleInput.effectiveTo", () => {
  it("accepts null to mean open-ended (clear end date), matching backend UpdateCommissionScheduleDto", () => {
    const parsed = CommissionScheduleInput.parse({ ...BASE, effectiveTo: null });
    expect(parsed.effectiveTo).toBeNull();
  });

  it("still accepts an ISO date string and omission", () => {
    expect(CommissionScheduleInput.parse({ ...BASE, effectiveTo: "2099-12-31" }).effectiveTo).toBe("2099-12-31");
    expect(CommissionScheduleInput.parse(BASE).effectiveTo).toBeUndefined();
  });
});
