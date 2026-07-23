import { createHash } from "node:crypto";
import { newDiffId } from "./diffStore.js";
import type {
  CommissionScheduleInput,
  CommissionScheduleRecord,
  DiffMode,
  DiffResult,
  DimensionValueDiffEntry,
  FieldDiffEntry,
  RateComponentDiffEntry,
} from "../../types/commissionSchedule.js";

function arraysEqualAsSets(a: string[] = [], b: string[] = []): boolean {
  if (a.length !== b.length) return false;
  const setA = new Set(a);
  return b.every((v) => setA.has(v));
}

function pushIfChanged(entries: FieldDiffEntry[], field: string, oldValue: unknown, newValue: unknown, equal?: boolean): void {
  const changed = equal !== undefined ? !equal : JSON.stringify(oldValue) !== JSON.stringify(newValue);
  if (changed) entries.push({ field, oldValue, newValue });
}

interface CurrentVersionShape {
  id?: string;
  dimensionValues?: Array<Record<string, unknown>>;
  rateComponents?: Array<Record<string, unknown>>;
}

function pickActiveVersion(record: CommissionScheduleRecord | undefined): CurrentVersionShape | undefined {
  if (!record?.versions?.length) return undefined;
  const versions = record.versions as Array<Record<string, unknown>>;
  return (versions.find((v) => v.isActive === true) ?? versions[0]) as CurrentVersionShape;
}

/**
 * Fingerprints "the part of the schedule a diff was computed against" -
 * the active version's identity/content plus the schedule's own updatedAt.
 * Used to detect a stale diff: if this doesn't match at apply time, the
 * schedule changed after the diff was computed and apply_change_request
 * must refuse rather than silently overwrite (see Task 3 / SPEC.md).
 * Returns undefined when there's no current record to pin (i.e.
 * mode='create_new_schedule') - nothing to go stale against.
 */
export function computeBaselineFingerprint(current: CommissionScheduleRecord | undefined): string | undefined {
  if (!current) return undefined;
  const activeVersion = pickActiveVersion(current);
  const canonical = JSON.stringify({
    updatedAt: current.updatedAt ?? null,
    activeVersionId: activeVersion?.id ?? null,
    dimensionValues: activeVersion?.dimensionValues ?? [],
    rateComponents: activeVersion?.rateComponents ?? [],
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function diffDimensionValues(
  current: CurrentVersionShape | undefined,
  proposed: CommissionScheduleInput["dimensionValues"]
): DimensionValueDiffEntry[] {
  const currentByCode = new Map<string, Record<string, unknown>>();
  for (const dv of current?.dimensionValues ?? []) {
    if (typeof dv.dimensionCode === "string") currentByCode.set(dv.dimensionCode, dv);
  }
  const proposedByCode = new Map(proposed.map((dv) => [dv.dimensionCode, dv]));

  const codes = new Set([...currentByCode.keys(), ...proposedByCode.keys()]);
  const out: DimensionValueDiffEntry[] = [];
  for (const code of codes) {
    const oldEntry = currentByCode.get(code);
    const newEntry = proposedByCode.get(code);
    if (oldEntry && !newEntry) {
      out.push({ dimensionCode: code, change: "removed", oldValue: extractDimensionValue(oldEntry) });
    } else if (!oldEntry && newEntry) {
      out.push({ dimensionCode: code, change: "added", newValue: extractDimensionValue(newEntry) });
    } else if (oldEntry && newEntry) {
      const oldV = extractDimensionValue(oldEntry);
      const newV = extractDimensionValue(newEntry);
      out.push({
        dimensionCode: code,
        change: JSON.stringify(oldV) === JSON.stringify(newV) ? "unchanged" : "modified",
        oldValue: oldV,
        newValue: newV,
      });
    }
  }
  return out;
}

function extractDimensionValue(dv: Record<string, unknown>): unknown {
  if (dv.value !== undefined && dv.value !== null) return dv.value;
  return { minNumericValue: dv.minNumericValue ?? null, maxNumericValue: dv.maxNumericValue ?? null };
}

function rateComponentKey(rc: { componentType: string; basisType: string; addonDefinitionId?: string | null }): string {
  return `${rc.componentType}::${rc.basisType}::${rc.addonDefinitionId ?? ""}`;
}

function diffRateComponents(
  current: CurrentVersionShape | undefined,
  proposed: CommissionScheduleInput["rateComponents"]
): RateComponentDiffEntry[] {
  const currentByKey = new Map<string, Record<string, unknown>>();
  for (const rc of current?.rateComponents ?? []) {
    if (typeof rc.componentType === "string" && typeof rc.basisType === "string") {
      currentByKey.set(
        rateComponentKey({
          componentType: rc.componentType,
          basisType: rc.basisType,
          addonDefinitionId: rc.addonDefinitionId as string | null | undefined,
        }),
        rc
      );
    }
  }
  const proposedByKey = new Map(proposed.map((rc) => [rateComponentKey(rc), rc]));

  const keys = new Set([...currentByKey.keys(), ...proposedByKey.keys()]);
  const out: RateComponentDiffEntry[] = [];
  for (const key of keys) {
    const oldRc = currentByKey.get(key);
    const newRc = proposedByKey.get(key);
    const [componentType, basisType, addonDefinitionIdRaw] = key.split("::");
    const addonDefinitionId = addonDefinitionIdRaw || undefined;
    if (oldRc && !newRc) {
      out.push({
        componentType,
        basisType,
        addonDefinitionId,
        change: "removed",
        oldRateType: oldRc.rateType as string | undefined,
        oldRateValue: oldRc.rateValue as number | undefined,
      });
    } else if (!oldRc && newRc) {
      out.push({
        componentType,
        basisType,
        addonDefinitionId,
        change: "added",
        newRateType: newRc.rateType,
        newRateValue: newRc.rateValue,
      });
    } else if (oldRc && newRc) {
      const unchanged = oldRc.rateType === newRc.rateType && oldRc.rateValue === newRc.rateValue;
      out.push({
        componentType,
        basisType,
        addonDefinitionId,
        change: unchanged ? "unchanged" : "modified",
        oldRateType: oldRc.rateType as string | undefined,
        oldRateValue: oldRc.rateValue as number | undefined,
        newRateType: newRc.rateType,
        newRateValue: newRc.rateValue,
      });
    }
  }
  return out;
}

/**
 * Computes the diff this server shows before staging a change request. The
 * real backend has no diff/compare endpoint of its own (see SPEC.md) - this
 * is a deliberate, documented deviation from "the backend computes the
 * diff": here, this MCP server computes it from a fresh GET of the current
 * schedule plus the caller-supplied proposal. The confirm-before-write gate
 * is unaffected - nothing is written to the backend until
 * apply_change_request(confirm: true) is called on a change request staged
 * from this exact diff.
 */
export function computeScheduleDiff(
  mode: DiffMode,
  current: CommissionScheduleRecord | undefined,
  proposed: CommissionScheduleInput
): DiffResult {
  const scopeChanges: FieldDiffEntry[] = [];
  const currentInsurerIds = (current?.insurers as Array<{ insurerId?: string }> | undefined)?.map((i) => i.insurerId ?? "") ?? [];
  const currentPlanIds = (current?.plans as Array<{ planId?: string }> | undefined)?.map((p) => p.planId ?? "") ?? [];
  const currentAddonIds =
    (current?.addons as Array<{ addonDefinitionId?: string }> | undefined)?.map((a) => a.addonDefinitionId ?? "") ?? [];

  pushIfChanged(scopeChanges, "name", current?.name, proposed.name);
  pushIfChanged(scopeChanges, "code", current?.code, proposed.code);
  pushIfChanged(scopeChanges, "priority", current?.priority, proposed.priority);
  pushIfChanged(scopeChanges, "lobProfile", current?.lobProfile, proposed.lobProfile);
  pushIfChanged(scopeChanges, "productId", current?.productId, proposed.productId);
  pushIfChanged(scopeChanges, "countryId", current?.countryId, proposed.countryId);
  pushIfChanged(
    scopeChanges,
    "insurerIds",
    currentInsurerIds,
    proposed.insurerIds,
    arraysEqualAsSets(currentInsurerIds, proposed.insurerIds)
  );
  pushIfChanged(
    scopeChanges,
    "planIds",
    currentPlanIds,
    proposed.planIds ?? [],
    arraysEqualAsSets(currentPlanIds, proposed.planIds ?? [])
  );
  pushIfChanged(
    scopeChanges,
    "addonDefinitionIds",
    currentAddonIds,
    proposed.addonDefinitionIds ?? [],
    arraysEqualAsSets(currentAddonIds, proposed.addonDefinitionIds ?? [])
  );

  const activeVersion = pickActiveVersion(current);
  pushIfChanged(scopeChanges, "effectiveFrom", activeVersion ? (activeVersion as Record<string, unknown>).effectiveFrom : undefined, proposed.effectiveFrom);
  pushIfChanged(scopeChanges, "effectiveTo", activeVersion ? (activeVersion as Record<string, unknown>).effectiveTo : undefined, proposed.effectiveTo);

  return {
    diffId: newDiffId(),
    mode,
    scheduleId: current?.id,
    scopeChanges,
    dimensionValueChanges: diffDimensionValues(activeVersion, proposed.dimensionValues),
    rateComponentChanges: diffRateComponents(activeVersion, proposed.rateComponents),
    proposed,
    expiresAt: new Date(Date.now() + Number(process.env.DIFF_TTL_SECONDS ?? "900") * 1000).toISOString(),
    baselineFingerprint: computeBaselineFingerprint(current),
  };
}
