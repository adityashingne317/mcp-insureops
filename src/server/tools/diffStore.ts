import { randomUUID } from "node:crypto";
import type { ChangeRequest, ChangeRequestStatus, DiffResult } from "../../types/commissionSchedule.js";
import { db } from "./db.js";

/**
 * The real backend has no "compute a diff / stage a change request" concept
 * of its own (see SPEC.md) - it only exposes plain CRUD + version-activate
 * endpoints. To still satisfy "compute-then-confirm for writes", this
 * server computes diffs itself and holds them here until create_change_request
 * / apply_change_request / reject_change_request consume them.
 *
 * Backed by a local SQLite file (see db.ts) so the change-request/audit
 * trail survives a process restart.
 *
 * CAVEAT: this is still single-instance state (SQLite is a local file), which
 * is in tension with the otherwise-stateless-per-request design used
 * elsewhere in this server. It's fine for one instance. If this service is
 * ever deployed behind a load balancer with multiple instances, back this
 * with a shared store (Redis/Postgres, etc.) instead - a diffId/
 * changeRequestId minted on one instance must remain resolvable regardless
 * of which instance handles the follow-up call.
 */

const DIFF_TTL_MS = Number(process.env.DIFF_TTL_SECONDS ?? "900") * 1000;

function sweepExpiredDiffs(): void {
  db.prepare(`DELETE FROM diffs WHERE expires_at < ?`).run(Date.now());
}

export function newDiffId(): string {
  return `diff_${randomUUID()}`;
}

export function saveDiff(diff: DiffResult, tenantId: string): void {
  sweepExpiredDiffs();
  db.prepare(
    `INSERT INTO diffs (diff_id, tenant_id, expires_at, diff_json)
     VALUES (@diffId, @tenantId, @expiresAt, @diffJson)
     ON CONFLICT(diff_id) DO UPDATE SET
       tenant_id = excluded.tenant_id,
       expires_at = excluded.expires_at,
       diff_json = excluded.diff_json`
  ).run({
    diffId: diff.diffId,
    tenantId,
    expiresAt: Date.now() + DIFF_TTL_MS,
    diffJson: JSON.stringify(diff),
  });
}

/** Removes and returns the diff - a diffId can only be turned into one change request. */
export function takeDiff(diffId: string, tenantId: string): DiffResult | undefined {
  sweepExpiredDiffs();
  const row = db.prepare(`SELECT tenant_id AS tenantId, diff_json AS diffJson FROM diffs WHERE diff_id = ?`).get(diffId) as
    | { tenantId: string; diffJson: string }
    | undefined;
  if (!row || row.tenantId !== tenantId) return undefined;
  db.prepare(`DELETE FROM diffs WHERE diff_id = ?`).run(diffId);
  return JSON.parse(row.diffJson) as DiffResult;
}

export function createChangeRequest(params: {
  diff: DiffResult;
  tenantId: string;
  createdBy: string;
  sourceReference: string;
  notes?: string;
}): ChangeRequest {
  const changeRequest: ChangeRequest = {
    changeRequestId: `cr_${randomUUID()}`,
    diffId: params.diff.diffId,
    mode: params.diff.mode,
    scheduleId: params.diff.scheduleId,
    status: "PENDING_CONFIRMATION",
    sourceReference: params.sourceReference,
    notes: params.notes,
    createdAt: new Date().toISOString(),
    createdBy: params.createdBy,
    tenantId: params.tenantId,
  };
  db.prepare(
    `INSERT INTO change_requests
       (change_request_id, tenant_id, status, created_at, change_request_json, diff_json)
     VALUES (@changeRequestId, @tenantId, @status, @createdAt, @changeRequestJson, @diffJson)`
  ).run({
    changeRequestId: changeRequest.changeRequestId,
    tenantId: changeRequest.tenantId,
    status: changeRequest.status,
    createdAt: changeRequest.createdAt,
    changeRequestJson: JSON.stringify(changeRequest),
    diffJson: JSON.stringify(params.diff),
  });
  return changeRequest;
}

export function getChangeRequest(
  changeRequestId: string,
  tenantId: string
): { changeRequest: ChangeRequest; diff: DiffResult } | undefined {
  const row = db
    .prepare(
      `SELECT tenant_id AS tenantId, change_request_json AS changeRequestJson, diff_json AS diffJson
       FROM change_requests WHERE change_request_id = ?`
    )
    .get(changeRequestId) as { tenantId: string; changeRequestJson: string; diffJson: string } | undefined;
  if (!row || row.tenantId !== tenantId) return undefined;
  return {
    changeRequest: JSON.parse(row.changeRequestJson) as ChangeRequest,
    diff: JSON.parse(row.diffJson) as DiffResult,
  };
}

export function listChangeRequests(
  tenantId: string,
  filter?: { status?: ChangeRequestStatus }
): ChangeRequest[] {
  const rows = filter?.status
    ? db
        .prepare(
          `SELECT change_request_json AS changeRequestJson FROM change_requests
           WHERE tenant_id = ? AND status = ? ORDER BY created_at DESC`
        )
        .all(tenantId, filter.status)
    : db
        .prepare(
          `SELECT change_request_json AS changeRequestJson FROM change_requests
           WHERE tenant_id = ? ORDER BY created_at DESC`
        )
        .all(tenantId);
  return (rows as { changeRequestJson: string }[]).map((r) => JSON.parse(r.changeRequestJson) as ChangeRequest);
}

export function setChangeRequestStatus(
  changeRequestId: string,
  tenantId: string,
  status: ChangeRequestStatus
): ChangeRequest | undefined {
  const entry = getChangeRequest(changeRequestId, tenantId);
  if (!entry) return undefined;
  entry.changeRequest.status = status;
  db.prepare(`UPDATE change_requests SET status = ?, change_request_json = ? WHERE change_request_id = ?`).run(
    status,
    JSON.stringify(entry.changeRequest),
    changeRequestId
  );
  return entry.changeRequest;
}
