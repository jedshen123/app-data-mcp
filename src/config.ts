import "dotenv/config";

export const ACCESS_MODE = "read-only" as const;

const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 50;
const DEFAULT_RESULT_ROW_LIMIT = 100;
const MAX_RESULT_ROW_LIMIT = 500;
const MAX_RESPONSE_BYTES = 1_000_000;

export type MetabaseAuthConfig =
  | {
      mode: "api-key";
      baseUrl: string;
      apiKey: string;
    }
  | {
      mode: "user-pass";
      baseUrl: string;
      user: string;
      pass: string;
    }
  | {
      mode: "missing";
      baseUrl?: string;
      missing: string[];
    };

export function getHttpConfig() {
  return {
    host: process.env.MCP_HTTP_HOST ?? "127.0.0.1",
    port: Number.parseInt(process.env.MCP_HTTP_PORT ?? "3000", 10),
    bearerToken: process.env.MCP_HTTP_BEARER_TOKEN,
    allowedHosts: process.env.MCP_HTTP_ALLOWED_HOSTS?.split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  };
}

export function getAuthConfig() {
  return {
    publicBaseUrl: process.env.APP_DATA_MCP_PUBLIC_BASE_URL,
    sessionFile: process.env.APP_DATA_SESSION_FILE ?? ".data/metabase-sessions.json",
    metabaseLoginUrl: process.env.METABASE_LOGIN_URL ?? process.env.METABASE_BASE_URL ?? "https://app-data.luteos.site",
    metabaseAuthMode: process.env.METABASE_AUTH_MODE ?? "user-session",
    allowServiceFallback: readBoolean("METABASE_ALLOW_SERVICE_FALLBACK", false),
    metabaseSessionTtlHours: readPositiveInt("METABASE_SESSION_TTL_HOURS", 168),
    adminSessionPersistent: readBoolean("ADMIN_SESSION_PERSISTENT", true),
    adminSessionTtlHours: readPositiveInt("ADMIN_SESSION_TTL_HOURS", 168),
    adminSessionTable: process.env.ADMIN_SESSION_TABLE ?? "app_data_mcp_admin_sessions",
    requireUserHeader: readBoolean("APP_DATA_REQUIRE_AUTH_TOKEN", readBoolean("APP_DATA_REQUIRE_USER_HEADER", true))
  };
}

export function getDataLimitConfig() {
  return {
    defaultSearchLimit: readPositiveInt("DATA_DEFAULT_SEARCH_LIMIT", DEFAULT_SEARCH_LIMIT),
    maxSearchLimit: readPositiveInt("DATA_MAX_SEARCH_LIMIT", MAX_SEARCH_LIMIT),
    defaultResultRowLimit: readPositiveInt("DATA_DEFAULT_RESULT_ROW_LIMIT", DEFAULT_RESULT_ROW_LIMIT),
    maxResultRowLimit: readPositiveInt("DATA_MAX_RESULT_ROW_LIMIT", MAX_RESULT_ROW_LIMIT),
    maxResponseBytes: readPositiveInt("DATA_MAX_RESPONSE_BYTES", MAX_RESPONSE_BYTES)
  };
}

export function getAudienceExportConfig() {
  return {
    directory: process.env.AUDIENCE_EXPORT_DIR ?? ".data/audience-exports",
    ttlHours: readPositiveInt("AUDIENCE_EXPORT_TTL_HOURS", 24),
    maxRows: readPositiveInt("AUDIENCE_EXPORT_MAX_ROWS", 100_000),
    maxBytes: readPositiveInt("AUDIENCE_EXPORT_MAX_BYTES", 20_000_000)
  };
}

export function getSyncFreshnessConfig() {
  return {
    metabaseMetadataSyncIntervalHours: readPositiveInt("METABASE_METADATA_SYNC_INTERVAL_HOURS", 6),
    metabasePermissionSyncIntervalHours: readPositiveInt("METABASE_PERMISSION_SYNC_INTERVAL_HOURS", 6),
    posthogMetadataSyncIntervalHours: readPositiveInt("POSTHOG_METADATA_SYNC_INTERVAL_HOURS", 12)
  };
}

export function getAuditConfig() {
  return {
    enabled: readBoolean("AUDIT_LOG_ENABLED", process.env.DB_TYPE === "postgres"),
    dbType: process.env.DB_TYPE,
    host: process.env.DB_HOST,
    port: readPositiveInt("DB_PORT", 5432),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    schema: process.env.DB_SCHEMA ?? "public",
    table: process.env.AUDIT_LOG_TABLE ?? "app_data_mcp_audit_logs",
    ssl: readBoolean("DB_SSL", false),
    sslRejectUnauthorized: readBoolean("DB_SSL_REJECT_UNAUTHORIZED", true),
    sslCaFile: process.env.DB_SSL_CA_FILE
  };
}

export function getMetadataConfig() {
  return {
    dbType: process.env.DB_TYPE,
    host: process.env.DB_HOST,
    port: readPositiveInt("DB_PORT", 5432),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    schema: process.env.DB_SCHEMA ?? "public",
    table: process.env.METADATA_TABLE ?? "app_data_mcp_assets",
    defaultPublished: readBoolean("METADATA_DEFAULT_PUBLISHED", false),
    ssl: readBoolean("DB_SSL", false),
    sslRejectUnauthorized: readBoolean("DB_SSL_REJECT_UNAUTHORIZED", true),
    sslCaFile: process.env.DB_SSL_CA_FILE
  };
}

export function getToolManagementConfig() {
  return {
    schema: process.env.DB_SCHEMA ?? "public",
    table: process.env.MCP_TOOLS_TABLE ?? "app_data_mcp_tools",
    settingsTable: process.env.MCP_SETTINGS_TABLE ?? "app_data_mcp_settings"
  };
}

export function getMetabaseConfig(): MetabaseAuthConfig {
  const baseUrl = process.env.METABASE_BASE_URL;
  const apiKey = process.env.METABASE_API_KEY;
  const user = process.env.METABASE_USER ?? process.env.METABASE_USERNAME;
  const pass = process.env.METABASE_PASS ?? process.env.METABASE_PASSWORD;

  if (baseUrl && apiKey) {
    return {
      mode: "api-key",
      baseUrl,
      apiKey
    };
  }

  if (baseUrl && user && pass) {
    return {
      mode: "user-pass",
      baseUrl,
      user,
      pass
    };
  }

  return {
    mode: "missing",
    baseUrl,
    missing: [
      !baseUrl ? "METABASE_BASE_URL" : undefined,
      !apiKey && !user ? "METABASE_USER or METABASE_API_KEY" : undefined,
      !apiKey && !pass ? "METABASE_PASS or METABASE_API_KEY" : undefined
    ].filter((value): value is string => Boolean(value))
  };
}

export function getMetabasePublicUrl(): string | undefined {
  return process.env.METABASE_PUBLIC_URL ?? process.env.METABASE_EXTERNAL_URL;
}

export function getPostHogConfig() {
  return {
    baseUrl: process.env.POSTHOG_BASE_URL,
    projectId: process.env.POSTHOG_PROJECT_ID,
    personalApiKey: process.env.POSTHOG_PERSONAL_API_KEY ?? process.env.POSTHOG_API_KEY
  };
}

export function getStarRocksConfig() {
  const host = process.env.STARROCKS_HOST;
  const user = process.env.STARROCKS_USER;
  const database = process.env.STARROCKS_DATABASE;

  return {
    configured: Boolean(host && user && database),
    host,
    port: readPositiveInt("STARROCKS_PORT", 9030),
    user,
    password: process.env.STARROCKS_PASSWORD,
    database,
    connectionLimit: readPositiveInt("STARROCKS_CONNECTION_LIMIT", 10),
    connectTimeoutMs: readPositiveInt("STARROCKS_CONNECT_TIMEOUT_MS", 10_000),
    queryTimeoutMs: readPositiveInt("STARROCKS_QUERY_TIMEOUT_MS", 30_000),
    maxSqlLength: readPositiveInt("STARROCKS_MAX_SQL_LENGTH", 50_000),
    ssl: readBoolean("STARROCKS_SSL", false),
    sslRejectUnauthorized: readBoolean("STARROCKS_SSL_REJECT_UNAUTHORIZED", true),
    missing: [
      !host ? "STARROCKS_HOST" : undefined,
      !user ? "STARROCKS_USER" : undefined,
      !database ? "STARROCKS_DATABASE" : undefined
    ].filter((value): value is string => Boolean(value))
  };
}

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}
