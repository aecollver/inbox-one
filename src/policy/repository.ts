import path from "node:path";
import os from "node:os";
import { mkdirSync } from "node:fs";
import Database from "better-sqlite3";

export type Policy = {
  connectionId: string;
  folderPath: string;
  retentionDays: number;
  selectionCriteria?: string;
  updatedAt: string;
};

export type SetPolicyInput = {
  connectionId: string;
  folderPath: string;
  retentionDays: number;
  selectionCriteria?: string;
};

export type ListPoliciesFilter = {
  connectionId?: string;
  folderPath?: string;
};

type PolicyRow = {
  connection_id: string;
  folder_path: string;
  retention_days: number;
  selection_criteria: string | null;
  updated_at: string;
};

export class PolicyRepository {
  private readonly db: Database.Database;

  constructor(dbPath = path.join(os.homedir(), ".inbox-one", "inbox.db")) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS folder_policy (
        connection_id TEXT NOT NULL,
        folder_path TEXT NOT NULL,
        retention_days INTEGER NOT NULL,
        selection_criteria TEXT,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (connection_id, folder_path)
      )
    `);
    this.ensureSelectionCriteriaColumn();
  }

  getPolicy(connectionId: string, folderPath: string): Policy | undefined {
    const row = this.db
      .prepare<[string, string], PolicyRow>(`
        SELECT connection_id, folder_path, retention_days, selection_criteria, updated_at
        FROM folder_policy
        WHERE connection_id = ? AND folder_path = ?
      `)
      .get(connectionId, folderPath);

    return row ? this.toPolicy(row) : undefined;
  }

  listPolicies(filter: ListPoliciesFilter = {}): Policy[] {
    const clauses: string[] = [];
    const params: Record<string, string> = {};

    if (filter.connectionId) {
      clauses.push("connection_id = @connectionId");
      params.connectionId = filter.connectionId;
    }

    if (filter.folderPath) {
      clauses.push("folder_path = @folderPath");
      params.folderPath = filter.folderPath;
    }

    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";

    return this.db
      .prepare<Record<string, string>, PolicyRow>(`
        SELECT connection_id, folder_path, retention_days, selection_criteria, updated_at
        FROM folder_policy
        ${whereClause}
        ORDER BY connection_id, folder_path
      `)
      .all(params)
      .map((row) => this.toPolicy(row));
  }

  setPolicy(policy: SetPolicyInput): Policy {
    this.validatePolicy(policy);
    this.db
      .prepare(`
        INSERT INTO folder_policy (connection_id, folder_path, retention_days, selection_criteria, updated_at)
        VALUES (@connectionId, @folderPath, @retentionDays, @selectionCriteria, CURRENT_TIMESTAMP)
        ON CONFLICT(connection_id, folder_path) DO UPDATE SET
          retention_days = excluded.retention_days,
          selection_criteria = excluded.selection_criteria,
          updated_at = CURRENT_TIMESTAMP
      `)
      .run({
        ...policy,
        selectionCriteria: policy.selectionCriteria ?? null,
      });

    const savedPolicy = this.getPolicy(policy.connectionId, policy.folderPath);

    if (!savedPolicy) {
      throw new Error("Failed to save policy.");
    }

    return savedPolicy;
  }

  removePolicy(connectionId: string, folderPath: string): boolean {
    const result = this.db
      .prepare<[string, string]>(`
        DELETE FROM folder_policy
        WHERE connection_id = ? AND folder_path = ?
      `)
      .run(connectionId, folderPath);

    return result.changes > 0;
  }

  close(): void {
    this.db.close();
  }

  private toPolicy(row: PolicyRow): Policy {
    return {
      connectionId: row.connection_id,
      folderPath: row.folder_path,
      retentionDays: row.retention_days,
      selectionCriteria: row.selection_criteria ?? undefined,
      updatedAt: row.updated_at,
    };
  }

  private ensureSelectionCriteriaColumn(): void {
    const columns = this.db.prepare("PRAGMA table_info(folder_policy)").all() as { name: string }[];
    const hasSelectionCriteria = columns.some((column) => column.name === "selection_criteria");

    if (!hasSelectionCriteria) {
      this.db.exec("ALTER TABLE folder_policy ADD COLUMN selection_criteria TEXT");
    }
  }

  private validatePolicy(policy: SetPolicyInput): void {
    if (!policy.connectionId) {
      throw new Error("connectionId is required.");
    }

    if (!policy.folderPath) {
      throw new Error("folderPath is required.");
    }

    if (!Number.isInteger(policy.retentionDays) || policy.retentionDays < 0) {
      throw new Error("retentionDays must be a non-negative integer.");
    }
  }
}
