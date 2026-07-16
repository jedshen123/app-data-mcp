import { getToolManagementConfig } from "./config.js";
import { getMetadataPool, qualifiedName, quoteIdentifier } from "./metadataStore.js";

export type ToolRiskLevel = "low" | "medium" | "high";

export type ManagedTool = {
  name: string;
  title: string;
  description: string;
  category: string;
  riskLevel: ToolRiskLevel;
  enabled: boolean;
  updatedAt: string;
  updatedBy?: string;
  inputSchema: Record<string, unknown>;
  usageNotes: string;
};

const LEGACY_ENGLISH_MCP_SERVER_INSTRUCTIONS =
  "This server is a read-only internal data gateway. Prefer search_assets and run_asset for curated Metabase/PostHog data. Use query_starrocks only when curated assets do not answer the question or the user explicitly asks for SQL. Before querying unfamiliar StarRocks tables, inspect metadata with SHOW/DESCRIBE, then generate a bounded SELECT. Before running live Metabase data tools, call auth_status. If metabase.authorized is false, ask the user to open loginUrl and configure the personal MCP token as Authorization: Bearer <token>. Never ask for passwords in chat.";

export const DEFAULT_MCP_SERVER_INSTRUCTIONS =
  "这是一个只读的内部数据网关。对于已经治理的 Metabase/PostHog 数据，优先使用 search_assets 查找资产，并使用 run_asset 查询。只有当治理资产无法回答问题，或用户明确要求 SQL 时，才使用 query_starrocks。查询不熟悉的 StarRocks 表之前，先使用 SHOW/DESCRIBE 检查元信息，再生成有明确范围和行数限制的 SELECT。运行 Metabase 实时数据工具前，先调用 auth_status；如果 metabase.authorized 为 false，提示用户打开 loginUrl 完成登录，并将个人 MCP token 配置为 Authorization: Bearer <token>。不要在对话中索取或暴露密码、Session、API Key 等敏感信息。所有查询必须保持只读，并遵守返回行数限制。";

export const MCP_TOOL_DEFINITIONS = [
  { name: "search_assets", title: "搜索数据资产", category: "资产发现", riskLevel: "low", description: "搜索已开放的 Metabase、PostHog 和本地元信息，支持平台、类型和业务域过滤。", usageNotes: "通常作为数据分析的第一步。找到合适资产后，再调用 get_asset、trace_asset 或 run_asset。", inputSchema: { query: "string，关键词，默认空字符串", platform: "metabase | posthog | local，可选", type: "dashboard | card | insight | metric | table | event，可选", domain: "string，业务域，可选", limit: "integer，返回数量" } },
  { name: "get_asset", title: "查看资产详情", category: "元信息", riskLevel: "low", description: "读取单个资产的完整元信息，包括链接、查询定义、字段、参数和警告。", usageNotes: "需要先通过 search_assets 获得统一资产 ID；Metabase 资产还会实时校验当前用户权限。", inputSchema: { asset_id: "string，必填，例如 metabase:card:456" } },
  { name: "trace_asset", title: "追踪资产来源", category: "元信息", riskLevel: "low", description: "查看资产的查询定义、字段、上游来源、引用资产和原始平台链接。", usageNotes: "用于解释数据出处、SQL、字段和上游依赖，不执行数据查询。", inputSchema: { asset_id: "string，必填" } },
  { name: "run_asset", title: "运行数据资产", category: "数据查询", riskLevel: "medium", description: "使用当前用户权限实时运行 Metabase 卡片/Dashboard 或 PostHog Insight，并限制返回行数。", usageNotes: "优先运行已治理资产。Metabase 调用前建议先检查 auth_status；参数应来自资产 parameters。", inputSchema: { asset_id: "string，必填", params: "object，可选，友好参数或平台原生参数", limit: "integer，返回行数限制" } },
  { name: "query_starrocks", title: "查询 StarRocks", category: "数据查询", riskLevel: "high", description: "执行受控的只读 StarRocks SQL，允许 SELECT、WITH、SHOW、DESCRIBE 和 EXPLAIN。", usageNotes: "仅在治理资产不能回答问题或用户明确要求 SQL 时使用；陌生表应先 SHOW/DESCRIBE。", inputSchema: { sql: "string，必填，单条只读 SQL", limit: "integer，返回行数限制" } },
  { name: "list_domains", title: "列出业务域", category: "资产发现", riskLevel: "low", description: "列出当前用户可见的已开放资产业务域。", usageNotes: "可用于帮助 AI 缩小 search_assets 的 domain 范围。", inputSchema: {} },
  { name: "catalog_status", title: "查看目录状态", category: "运行状态", riskLevel: "low", description: "查看已开放元信息数量、平台和类型统计以及同步新鲜度。", usageNotes: "用于排查搜索不到资产、同步过期或目录未初始化问题。", inputSchema: {} },
  { name: "auth_status", title: "查看授权状态", category: "认证", riskLevel: "low", description: "检查当前 MCP 用户及其 Metabase 会话是否已授权，并返回重新登录提示。", usageNotes: "运行 Metabase 资产前调用；不返回密码或平台密钥。", inputSchema: {} },
  { name: "connector_status", title: "查看连接器状态", category: "运行状态", riskLevel: "low", description: "查看 Metabase、PostHog、StarRocks、元信息库和审计配置是否完整，不返回密钥。", usageNotes: "用于部署排障，只返回是否配置及非敏感连接信息。", inputSchema: {} }
] as const;

let initialized = false;
let initializationPromise: Promise<void> | undefined;

export async function listManagedTools(): Promise<ManagedTool[]> {
  await ensureToolTable();
  const pool = await getMetadataPool();
  const config = getToolManagementConfig();
  const result = await pool.query<{
    tool_name: string;
    title: string;
    description: string;
    category: string;
    risk_level: ToolRiskLevel;
    is_enabled: boolean;
    updated_at: Date;
    updated_by?: string;
    input_schema: Record<string, unknown>;
    usage_notes: string;
  }>(`select tool_name, title, description, category, risk_level, is_enabled, updated_at, updated_by, input_schema, usage_notes
      from ${qualifiedName(config.schema, config.table)} order by category, tool_name`);
  return result.rows.map((row) => ({
    name: row.tool_name,
    title: row.title,
    description: row.description,
    category: row.category,
    riskLevel: row.risk_level,
    enabled: row.is_enabled,
    updatedAt: row.updated_at.toISOString(),
    updatedBy: row.updated_by,
    inputSchema: row.input_schema,
    usageNotes: row.usage_notes
  }));
}

export async function getEnabledToolNames(): Promise<Set<string>> {
  return new Set((await listManagedTools()).filter((tool) => tool.enabled).map((tool) => tool.name));
}

export async function isManagedToolEnabled(toolName: string): Promise<boolean> {
  await ensureToolTable();
  const pool = await getMetadataPool();
  const config = getToolManagementConfig();
  const result = await pool.query<{ is_enabled: boolean }>(
    `select is_enabled from ${qualifiedName(config.schema, config.table)} where tool_name = $1`,
    [toolName]
  );
  return result.rows[0]?.is_enabled === true;
}

export function buildEffectiveInstructions(baseInstructions: string, tools: ManagedTool[]): string {
  const disabled = tools.filter((tool) => !tool.enabled);
  if (!disabled.length) return baseInstructions;

  const lines = [
    baseInstructions.trim(),
    "",
    "【当前 MCP 工具开放状态（由服务端强制执行）】",
    `以下工具未开放：${disabled.map((tool) => `${tool.name}（${tool.title}）`).join("、")}。`,
    "不要尝试调用未开放的工具。当用户请求依赖这些工具的能力时，应明确说明对应 MCP 工具未开放；不要把“工具未开放”描述成“连接器未配置”。"
  ];
  if (disabled.some((tool) => tool.name === "query_starrocks")) {
    lines.push(
      "query_starrocks 当前未开放。如果用户要求直接查询 StarRocks 表、执行自定义 SQL、SHOW 或 DESCRIBE，应明确告知：SQL 查询工具 query_starrocks 未开放，当前无法通过此 MCP 直接查询表数据。仍可搜索和运行已开放的 Metabase/PostHog 资产，但不要声称必须创建新的 Metabase 卡片。"
    );
  }
  return lines.join("\n");
}

export async function updateManagedTool(toolName: string, enabled: boolean, updatedBy: string): Promise<ManagedTool | undefined> {
  await ensureToolTable();
  const pool = await getMetadataPool();
  const config = getToolManagementConfig();
  const result = await pool.query<{
    tool_name: string;
    title: string;
    description: string;
    category: string;
    risk_level: ToolRiskLevel;
    is_enabled: boolean;
    updated_at: Date;
    updated_by?: string;
    input_schema: Record<string, unknown>;
    usage_notes: string;
  }>(`update ${qualifiedName(config.schema, config.table)}
      set is_enabled = $2, updated_at = now(), updated_by = $3
      where tool_name = $1
      returning tool_name, title, description, category, risk_level, is_enabled, updated_at, updated_by, input_schema, usage_notes`,
    [toolName, enabled, updatedBy]
  );
  const row = result.rows[0];
  return row ? {
    name: row.tool_name,
    title: row.title,
    description: row.description,
    category: row.category,
    riskLevel: row.risk_level,
    enabled: row.is_enabled,
    updatedAt: row.updated_at.toISOString(),
    updatedBy: row.updated_by,
    inputSchema: row.input_schema,
    usageNotes: row.usage_notes
  } : undefined;
}

export async function getGlobalInstructions(): Promise<string> {
  await ensureToolTable();
  const pool = await getMetadataPool();
  const config = getToolManagementConfig();
  const result = await pool.query<{ setting_value: string }>(
    `select setting_value from ${qualifiedName(config.schema, config.settingsTable)} where setting_key = 'global_instructions'`
  );
  return result.rows[0]?.setting_value ?? DEFAULT_MCP_SERVER_INSTRUCTIONS;
}

export async function updateGlobalInstructions(value: string, updatedBy: string): Promise<string> {
  await ensureToolTable();
  const pool = await getMetadataPool();
  const config = getToolManagementConfig();
  const result = await pool.query<{ setting_value: string }>(
    `insert into ${qualifiedName(config.schema, config.settingsTable)} (setting_key, setting_value, updated_at, updated_by)
     values ('global_instructions', $1, now(), $2)
     on conflict (setting_key) do update set setting_value = excluded.setting_value, updated_at = now(), updated_by = excluded.updated_by
     returning setting_value`,
    [value, updatedBy]
  );
  return result.rows[0]?.setting_value ?? value;
}

export async function ensureToolTable(): Promise<void> {
  if (initialized) return;
  initializationPromise ??= initializeToolTable().catch((error) => {
    initializationPromise = undefined;
    throw error;
  });
  await initializationPromise;
  initialized = true;
}

async function initializeToolTable(): Promise<void> {
  const pool = await getMetadataPool();
  const connection = await pool.connect();
  const config = getToolManagementConfig();
  const tableName = qualifiedName(config.schema, config.table);
  const settingsTableName = qualifiedName(config.schema, config.settingsTable);
  try {
    await connection.query("begin");
    await connection.query("select pg_advisory_xact_lock(hashtext($1))", [`app-data-mcp-tools:${tableName}`]);
    await connection.query(`create table if not exists ${tableName} (
      tool_name text primary key,
      title text not null,
      description text not null,
      category text not null,
      risk_level text not null,
      is_enabled boolean not null default true,
      input_schema jsonb not null default '{}'::jsonb,
      usage_notes text not null default '',
      updated_at timestamptz not null default now(),
      updated_by text
    )`);
    await connection.query(`alter table ${tableName} add column if not exists input_schema jsonb not null default '{}'::jsonb`);
    await connection.query(`alter table ${tableName} add column if not exists usage_notes text not null default ''`);
    await connection.query(`create table if not exists ${settingsTableName} (
      setting_key text primary key,
      setting_value text not null,
      updated_at timestamptz not null default now(),
      updated_by text
    )`);
    await connection.query(
      `insert into ${settingsTableName} (setting_key, setting_value)
       values ('global_instructions', $1)
       on conflict (setting_key) do nothing`,
      [DEFAULT_MCP_SERVER_INSTRUCTIONS]
    );
    await connection.query(
      `update ${settingsTableName}
       set setting_value = $1, updated_at = now(), updated_by = 'system-default-migration'
       where setting_key = 'global_instructions' and setting_value = $2`,
      [DEFAULT_MCP_SERVER_INSTRUCTIONS, LEGACY_ENGLISH_MCP_SERVER_INSTRUCTIONS]
    );
    for (const tool of MCP_TOOL_DEFINITIONS) {
      await connection.query(
        `insert into ${tableName} (tool_name, title, description, category, risk_level, input_schema, usage_notes, is_enabled)
         values ($1, $2, $3, $4, $5, $6::jsonb, $7, true)
         on conflict (tool_name) do update set
           title = excluded.title,
           description = excluded.description,
           category = excluded.category,
           risk_level = excluded.risk_level,
           input_schema = excluded.input_schema,
           usage_notes = excluded.usage_notes`,
        [tool.name, tool.title, tool.description, tool.category, tool.riskLevel, JSON.stringify(tool.inputSchema), tool.usageNotes]
      );
    }
    await connection.query(`create index if not exists ${quoteIdentifier(`${config.table}_enabled_idx`)} on ${tableName} (is_enabled, category)`);
    await connection.query("commit");
  } catch (error) {
    await connection.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    connection.release();
  }
}
