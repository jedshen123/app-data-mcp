import mysql, {
  type FieldPacket,
  type Pool,
  type PoolConnection,
  type RowDataPacket
} from "mysql2/promise";
import { getStarRocksConfig } from "../config.js";

const ALLOWED_FIRST_KEYWORDS = new Set(["SELECT", "WITH", "SHOW", "DESCRIBE", "DESC", "EXPLAIN"]);
const FORBIDDEN_KEYWORDS = new Set([
  "ALTER",
  "ANALYZE",
  "ADMIN",
  "BACKUP",
  "CALL",
  "CANCEL",
  "CREATE",
  "DELETE",
  "DROP",
  "EXPORT",
  "GRANT",
  "INSERT",
  "INTO",
  "KILL",
  "LOAD",
  "LOCK",
  "OPTIMIZE",
  "RENAME",
  "REPLACE",
  "RESTORE",
  "REVOKE",
  "SET",
  "SUBMIT",
  "TRUNCATE",
  "UNLOCK",
  "UPDATE",
  "USE"
]);
const FORBIDDEN_FUNCTIONS = new Set(["BENCHMARK", "FILES", "LOAD_FILE", "SLEEP"]);

export type StarRocksQueryResult = {
  columns: Array<{ name: string; type?: number }>;
  rows: Record<string, unknown>[];
  rowCount: number;
  limitApplied: number;
  truncated: boolean;
  database: string;
};

let pool: Pool | undefined;

export async function runStarRocksQuery(sql: string, limit: number): Promise<StarRocksQueryResult> {
  const config = getStarRocksConfig();
  if (!config.configured || !config.host || !config.user || !config.database) {
    throw new Error(`starrocks_not_configured: missing ${config.missing.join(", ")}`);
  }

  validateReadOnlySql(sql, config.maxSqlLength);
  const connection = await getPool().getConnection();
  try {
    await configureReadOnlySession(connection, limit + 1, config.queryTimeoutMs);
    const [rawRows, fields] = await connection.query<RowDataPacket[]>({
      sql,
      timeout: config.queryTimeoutMs
    });
    if (!Array.isArray(rawRows)) {
      throw new Error("starrocks_unexpected_result: query did not return rows");
    }

    const rows = rawRows.slice(0, limit).map((row) => ({ ...row }));
    return {
      columns: normalizeFields(fields),
      rows,
      rowCount: rows.length,
      limitApplied: limit,
      truncated: rawRows.length > limit,
      database: config.database
    };
  } finally {
    connection.release();
  }
}

export function validateReadOnlySql(sql: string, maxSqlLength = 50_000): void {
  const trimmed = sql.trim();
  if (!trimmed) throw new Error("invalid_sql: SQL must not be empty");
  if (Buffer.byteLength(trimmed, "utf8") > maxSqlLength) {
    throw new Error(`invalid_sql: SQL exceeds the ${maxSqlLength}-byte limit`);
  }
  if (/\/\*[!+]/.test(trimmed)) {
    throw new Error("readonly_sql_required: executable comments and query hints are not allowed");
  }

  const sanitized = sanitizeSql(trimmed);
  const semicolons = Array.from(sanitized.matchAll(/;/g)).map((match) => match.index ?? -1);
  if (semicolons.length > 1 || (semicolons.length === 1 && sanitized.slice(semicolons[0] + 1).trim())) {
    throw new Error("readonly_sql_required: only one SQL statement is allowed");
  }

  const tokens = sanitized.match(/[A-Za-z_][A-Za-z0-9_$]*/g)?.map((token) => token.toUpperCase()) ?? [];
  const firstKeyword = tokens[0];
  if (!firstKeyword || !ALLOWED_FIRST_KEYWORDS.has(firstKeyword)) {
    throw new Error("readonly_sql_required: SQL must start with SELECT, WITH, SHOW, DESCRIBE, DESC, or EXPLAIN");
  }
  if (firstKeyword === "WITH" && !tokens.includes("SELECT")) {
    throw new Error("readonly_sql_required: WITH statements must end in a SELECT query");
  }

  const forbiddenKeyword = tokens.find(
    (token, index) =>
      FORBIDDEN_KEYWORDS.has(token) && !(firstKeyword === "SHOW" && index === 1 && token === "CREATE")
  );
  if (forbiddenKeyword) {
    throw new Error(`readonly_sql_required: ${forbiddenKeyword} is not allowed`);
  }
  const forbiddenFunction = Array.from(FORBIDDEN_FUNCTIONS).find((functionName) =>
    new RegExp(`\\b${functionName}\\s*\\(`, "i").test(sanitized)
  );
  if (forbiddenFunction) {
    throw new Error(`readonly_sql_required: ${forbiddenFunction} is not allowed`);
  }
  if (/@[A-Za-z0-9_$]+\s*:=/i.test(sanitized)) {
    throw new Error("readonly_sql_required: session variable assignment is not allowed");
  }
}

function getPool(): Pool {
  if (pool) return pool;
  const config = getStarRocksConfig();
  if (!config.host || !config.user || !config.database) {
    throw new Error("starrocks_not_configured");
  }

  pool = mysql.createPool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    connectionLimit: config.connectionLimit,
    connectTimeout: config.connectTimeoutMs,
    enableKeepAlive: true,
    multipleStatements: false,
    supportBigNumbers: true,
    bigNumberStrings: true,
    dateStrings: true,
    ssl: config.ssl ? { rejectUnauthorized: config.sslRejectUnauthorized } : undefined
  });
  return pool;
}

async function configureReadOnlySession(
  connection: PoolConnection,
  rowLimit: number,
  timeoutMs: number
): Promise<void> {
  const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  await connection.query("SET query_timeout = ?", [timeoutSeconds]);
  await connection.query("SET sql_select_limit = ?", [rowLimit]);
}

function normalizeFields(fields: FieldPacket[]): Array<{ name: string; type?: number }> {
  return fields.map((field) => ({
    name: field.name,
    type: field.type
  }));
}

function sanitizeSql(sql: string): string {
  let output = "";
  let state: "normal" | "single" | "double" | "backtick" | "line-comment" | "block-comment" = "normal";

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    const next = sql[index + 1];

    if (state === "normal") {
      if (char === "'") state = "single";
      else if (char === '"') state = "double";
      else if (char === "`") state = "backtick";
      else if (char === "#" || (char === "-" && next === "-")) state = "line-comment";
      else if (char === "/" && next === "*") state = "block-comment";
      else output += char;
      if (state !== "normal") output += " ";
      continue;
    }

    output += char === "\n" || char === "\r" ? char : " ";
    if (state === "line-comment" && (char === "\n" || char === "\r")) state = "normal";
    else if (state === "block-comment" && char === "*" && next === "/") {
      output += " ";
      index += 1;
      state = "normal";
    } else if (state === "single" || state === "double" || state === "backtick") {
      const quote = state === "single" ? "'" : state === "double" ? '"' : "`";
      if (char === "\\") {
        output += " ";
        index += 1;
      } else if (char === quote && next === quote) {
        output += " ";
        index += 1;
      } else if (char === quote) {
        state = "normal";
      }
    }
  }

  if (state === "single" || state === "double" || state === "backtick" || state === "block-comment") {
    throw new Error("invalid_sql: unterminated quote or comment");
  }
  return output;
}
