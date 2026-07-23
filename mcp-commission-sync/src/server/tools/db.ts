import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

/**
 * File-backed store for diffs/change-requests (see diffStore.ts). SQLite is
 * enough here because horizontal scaling is explicitly out of scope for now
 * (see SPEC.md Section 11 / plan "Explicitly out of scope") - this only
 * needs to survive a process restart, not be shared across instances. If
 * that requirement changes later, swap this module for a Redis/Postgres
 * client and keep diffStore.ts's exported function signatures the same.
 */
const DB_PATH = process.env.DB_PATH ?? "./data/commission-sync.sqlite";

mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS diffs (
    diff_id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    diff_json TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS change_requests (
    change_request_id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    change_request_json TEXT NOT NULL,
    diff_json TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_change_requests_tenant ON change_requests (tenant_id);
  CREATE INDEX IF NOT EXISTS idx_diffs_expires_at ON diffs (expires_at);
`);
