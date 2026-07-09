import { createHash } from "node:crypto";
import { Pool } from "pg";
import { getAuditConfig } from "./config.js";
import { getRequestContext } from "./requestContext.js";

type AuditStatus = "success" | "error" | "auth_required";

export type AuditDetails = {
  assetId?: string;
  assetPlatform?: string;
  assetType?: string;
  query?: string;
  params?: unknown;
  limit?: number;
  metadata?: Record<string, unknown>;
};

export type AuditOutputStats = {
  rowCount?: number;
  resultBytes?: number;
  errorCode?: string;
  errorMessage?: string;
};

let pool: Pool | undefined;
let initialized = false;

export async function auditToolCall<T>(
  toolName: string,
  details: AuditDetails,
  callback: () => Promise<T>
): Promise<T> {
  const startedAt = Date.now();
  try {
    const result = await callback();
    const stats = extractOutputStats(result);
    await writeAuditLog({
      toolName,
      details,
      durationMs: Date.now() - startedAt,
      status: stats.errorCode === "auth_required" ? "auth_required" : stats.errorCode ? "error" : "success",
      ...stats
    });
    return result;
  } catch (error) {
    await writeAuditLog({
      toolName,
      details,
      durationMs: Date.now() - startedAt,
      status: "error",
      errorCode: "exception",
      errorMessage: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}

async function writeAuditLog(input: {
  toolName: string;
  details: AuditDetails;
  durationMs: number;
  status: AuditStatus;
  rowCount?: number;
  resultBytes?: number;
  errorCode?: string;
  errorMessage?: string;
}) {
  const client = await getAuditPool();
  if (!client) return;

  try {
    await ensureAuditTable(client);
    const config = getAuditConfig();
    const requestContext = getRequestContext();
    const tableName = qualifiedName(config.schema, config.table);
    await client.query(
      `insert into ${tableName} (
        request_id,
        user_email,
        auth_method,
        ai_client,
        tool_name,
        asset_id,
        asset_platform,
        asset_type,
        query_text,
        params_hash,
        limit_applied,
        row_count,
        result_bytes,
        status,
        error_code,
        error_message,
        duration_ms,
        client_ip,
        user_agent,
        metadata
      ) values (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15, $16, $17, $18, $19, $20
      )`,
      [
        requestContext.requestId,
        requestContext.user,
        requestContext.authMethod ?? "none",
        requestContext.aiClient ?? "unknown",
        input.toolName,
        input.details.assetId,
        input.details.assetPlatform,
        input.details.assetType,
        input.details.query,
        input.details.params === undefined ? undefined : hashJson(input.details.params),
        input.details.limit,
        input.rowCount,
        input.resultBytes,
        input.status,
        input.errorCode,
        truncate(input.errorMessage, 1000),
        input.durationMs,
        requestContext.clientIp,
        requestContext.userAgent,
        JSON.stringify(input.details.metadata ?? {})
      ]
    );
  } catch (error) {
    console.error("Failed to write MCP audit log:", error);
  }
}

async function getAuditPool(): Promise<Pool | undefined> {
  const config = getAuditConfig();
  if (!config.enabled) return undefined;
  if (config.dbType !== "postgres") return undefined;
  if (!config.host || !config.user || !config.database) {
    console.error("Audit log is enabled but DB_HOST, DB_USER, or DB_NAME is missing.");
    return undefined;
  }

  pool ??= new Pool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database
  });
  return pool;
}

async function ensureAuditTable(client: Pool) {
  if (initialized) return;

  const config = getAuditConfig();
  const tableName = qualifiedName(config.schema, config.table);
  await client.query(`
    create table if not exists ${tableName} (
      id bigserial primary key,
      created_at timestamptz not null default now(),
      request_id text,
      user_email text,
      auth_method text,
      ai_client text,
      tool_name text not null,
      asset_id text,
      asset_platform text,
      asset_type text,
      query_text text,
      params_hash text,
      limit_applied integer,
      row_count integer,
      result_bytes integer,
      status text not null,
      error_code text,
      error_message text,
      duration_ms integer,
      client_ip text,
      user_agent text,
      metadata jsonb not null default '{}'::jsonb
    )
  `);
  await client.query(`alter table ${tableName} add column if not exists ai_client text`);
  await client.query(`create index if not exists ${quoteIdentifier(`${config.table}_created_at_idx`)} on ${tableName} (created_at desc)`);
  await client.query(`create index if not exists ${quoteIdentifier(`${config.table}_user_created_at_idx`)} on ${tableName} (user_email, created_at desc)`);
  await client.query(`create index if not exists ${quoteIdentifier(`${config.table}_asset_created_at_idx`)} on ${tableName} (asset_id, created_at desc)`);
  await client.query(`create index if not exists ${quoteIdentifier(`${config.table}_ai_client_created_at_idx`)} on ${tableName} (ai_client, created_at desc)`);
  initialized = true;
}

function extractOutputStats(output: unknown): AuditOutputStats {
  const text = readFirstTextContent(output);
  if (!text) return {};

  const stats: AuditOutputStats = {
    resultBytes: Buffer.byteLength(text, "utf8")
  };
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    stats.errorCode = typeof parsed.error === "string" ? parsed.error : undefined;
    stats.errorMessage = typeof parsed.message === "string" ? parsed.message : undefined;
    stats.rowCount = inferRowCount(parsed);
  } catch {
    return stats;
  }
  return stats;
}

function readFirstTextContent(output: unknown): string | undefined {
  if (!isObject(output) || !Array.isArray(output.content)) return undefined;
  const first = output.content[0];
  if (!isObject(first) || typeof first.text !== "string") return undefined;
  return first.text;
}

function inferRowCount(value: Record<string, unknown>): number | undefined {
  if (typeof value.count === "number") return value.count;
  if (isObject(value.data)) {
    if (typeof value.data.rowCount === "number") return value.data.rowCount;
    if (typeof value.data.totalRowsReturned === "number") return value.data.totalRowsReturned;
    if (Array.isArray(value.data.rows)) return value.data.rows.length;
    if (Array.isArray(value.data.cards)) {
      return value.data.cards.reduce((sum, card) => {
        if (!isObject(card) || !isObject(card.data)) return sum;
        if (typeof card.data.rowCount === "number") return sum + card.data.rowCount;
        if (typeof card.data.totalRowsReturned === "number") return sum + card.data.totalRowsReturned;
        if (Array.isArray(card.data.rows)) return sum + card.data.rows.length;
        return sum;
      }, 0);
    }
  }
  if (Array.isArray(value.assets)) return value.assets.length;
  return undefined;
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function qualifiedName(schema: string, table: string): string {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
}

function quoteIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`Invalid SQL identifier: ${value}`);
  }
  return `"${value}"`;
}

function truncate(value: string | undefined, maxLength: number): string | undefined {
  if (!value || value.length <= maxLength) return value;
  return value.slice(0, maxLength);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
