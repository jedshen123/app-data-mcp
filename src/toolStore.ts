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

const LEGACY_USER_SESSION_MCP_SERVER_INSTRUCTIONS =
  "这是一个只读的内部数据网关。对于已经治理的 Metabase/PostHog 数据，优先使用 search_assets 查找资产，并使用 run_asset 查询。只有当治理资产无法回答问题，或用户明确要求 SQL 时，才使用 query_starrocks。查询不熟悉的 StarRocks 表之前，先使用 SHOW/DESCRIBE 检查元信息，再生成有明确范围和行数限制的 SELECT。运行 Metabase 实时数据工具前，先调用 auth_status；如果 metabase.authorized 为 false，提示用户打开 loginUrl 完成登录，并将个人 MCP token 配置为 Authorization: Bearer <token>。不要在对话中索取或暴露密码、Session、API Key 等敏感信息。所有查询必须保持只读，并遵守返回行数限制。";

const LEGACY_SERVICE_ACCOUNT_MCP_SERVER_INSTRUCTIONS =
  "这是一个只读的内部数据网关。对于已经治理的 Metabase/PostHog 数据，优先使用 search_assets 查找资产，并使用 run_asset 查询。只有当治理资产无法回答问题，或用户明确要求 SQL 时，才使用 query_starrocks。查询不熟悉的 StarRocks 表之前，先使用 SHOW/DESCRIBE 检查元信息，再生成有明确范围和行数限制的 SELECT。Metabase 默认使用服务端账号或 API Key，不要求用户维护个人 Metabase Session；如果连接失败，应提示检查服务端连接配置，不要描述为用户授权过期。不要在对话中索取或暴露密码、Session、API Key 等敏感信息。所有查询必须保持只读，并遵守返回行数限制。";

const LEGACY_PRE_METRIC_MCP_SERVER_INSTRUCTIONS =
  "这是一个只读的内部数据网关。对于已经治理的 Metabase/PostHog 数据，优先使用 search_assets 查找资产，并使用 run_asset 查询。只有当治理资产无法回答问题，或用户明确要求 SQL 时，才使用 query_starrocks。查询不熟悉的 StarRocks 表之前，先使用 SHOW/DESCRIBE 检查元信息，再生成有明确范围和行数限制的 SELECT。每个个人 MCP token 对应一个 Metabase 账号，所有 Metabase 查询必须使用该 token 对应账号的权限。MCP 不按本地时间主动判定用户授权过期；只有个人 token 缺失、无对应账号，或 Metabase 实际拒绝当前 Session 时，才提示用户重新授权。不要改用统一服务账号绕过用户权限，也不要在对话中索取或暴露密码、Session、API Key 等敏感信息。所有查询必须保持只读，并遵守返回行数限制。";

const LEGACY_PRE_SEMANTIC_MCP_SERVER_INSTRUCTIONS =
  "这是一个只读的内部数据网关。对于已经治理的 Metabase/PostHog 数据，优先使用 search_assets 查找资产，并使用 run_asset 查询。Metabase Metric 是经过治理的标准指标；找到 type=metric 的资产时，先通过 get_asset 查看 metric.formula、dataSource、defaultTimeDimension、dimensions 和上下游依赖，再运行该指标或选择合适的拆分维度。只有当治理资产无法回答问题，或用户明确要求 SQL 时，才使用 query_starrocks。查询不熟悉的 StarRocks 表之前，先使用 SHOW/DESCRIBE 检查元信息，再生成有明确范围和行数限制的 SELECT。每个个人 MCP token 对应一个 Metabase 账号，所有 Metabase 查询必须使用该 token 对应账号的权限。MCP 不按本地时间主动判定用户授权过期；只有个人 token 缺失、无对应账号，或 Metabase 实际拒绝当前 Session 时，才提示用户重新授权。不要改用统一服务账号绕过用户权限，也不要在对话中索取或暴露密码、Session、API Key 等敏感信息。所有查询必须保持只读，并遵守返回行数限制。";

const LEGACY_PRE_SQL_GOVERNANCE_MCP_SERVER_INSTRUCTIONS =
  "这是一个只读的内部数据网关。对于已经治理的 Metabase/PostHog 数据，优先使用 search_assets 查找资产，并使用 run_asset 查询。Metabase Metric 是经过治理的标准指标：先用 get_asset 查看 metric.formula、dataSource、defaultTimeDimension 和 dimensions，再通过 run_asset.semantic.filters/breakouts 动态筛选或拆分，绝不能替换 Metric 公式。Metabase Model 是受控语义明细层：先查看 columns，再通过 run_asset.semantic.fields 获取指定明细字段，或者通过 semantic.aggregations 配合 breakouts 进行动态聚合。字段必须使用元信息中存在的名称；不要臆造字段。只有治理资产无法回答问题，或用户明确要求 SQL 时，才使用 query_starrocks。查询不熟悉的 StarRocks 表之前，先使用 SHOW/DESCRIBE 检查元信息，再生成有明确范围和行数限制的 SELECT。每个个人 MCP token 对应一个 Metabase 账号，所有 Metabase 查询必须使用该 token 对应账号的权限。MCP 不按本地时间主动判定用户授权过期；只有个人 token 缺失、无对应账号，或 Metabase 实际拒绝当前 Session 时，才提示用户重新授权。不要改用统一服务账号绕过用户权限，也不要在对话中索取或暴露密码、Session、API Key 等敏感信息。所有查询必须保持只读，并遵守返回行数限制。";

const LEGACY_PRE_AUDIENCE_MCP_SERVER_INSTRUCTIONS =
  "这是一个只读的内部数据网关。回答任何普通数据问题时，第一步必须调用 search_assets 检索已开放治理资产，不得凭记忆直接调用 query_starrocks。优先顺序是 Metric、Model、Card、Dashboard：Metric 是标准指标，先用 get_asset 查看公式和 dimensions，再用 run_asset.semantic.filters/breakouts 查询且绝不能替换公式；Model 是受控语义明细层，可用 semantic.fields 查询明细，或用 semantic.aggregations 配合 breakouts 聚合。只有 search_assets 没有合适结果，或逐个 get_asset 后确认候选资产不适用，才能回退 query_starrocks。query_starrocks 会在服务端再次检索治理资产并可能阻止 SQL；再次回退时必须提交 rejected_asset_ids 和具体 fallback_reason。只有用户明确要求直接 SQL 时才使用 purpose=user_requested_sql。字段必须来自元信息，不要臆造。每个个人 MCP token 对应一个 Metabase 账号，所有 Metabase 查询必须使用该账号权限。不要索取或暴露密码、Session、API Key。所有查询只读并遵守返回限制。";

const LEGACY_PRE_EXPORT_MCP_SERVER_INSTRUCTIONS =
  "这是一个只读的内部数据网关。回答普通数据问题时先用 search_assets 检索治理资产。Metric 使用 run_asset.semantic.filters/breakouts 且不得替换公式；单个 Model 使用 run_asset；当用户要求多个用户 Model 的交集、并集或排除关系时，先逐个 get_asset 确认都有 audience.uid 元数据，再使用 query_audience，禁止分别拉取 UID 后在客户端计算。只有治理资产不适用或用户明确要求 SQL 时才回退 query_starrocks。字段必须来自元信息。每个个人 MCP token 对应一个 Metabase 账号，所有查询必须使用该账号权限。不要索取或暴露密码、Session、API Key。所有查询只读并遵守返回限制。";

const LEGACY_PRE_METRIC_SELECTION_GOVERNANCE_MCP_SERVER_INSTRUCTIONS =
  "这是一个源数据只读的内部数据网关。回答普通数据问题时先用 search_assets 检索治理资产。Metric 使用 run_asset.semantic.filters/breakouts 且不得替换公式；单个 Model 使用 run_asset；多个用户 Model 的交、并、差使用 query_audience，禁止分别拉取 UID 后在客户端计算。需要完整 UID 文件时使用 export_audience，让服务端生成有期限的受控 CSV，不要声称有限的 query_audience 结果是完整人群。只有治理资产不适用或用户明确要求 SQL 时才回退 query_starrocks。字段必须来自元信息。所有查询必须使用个人 MCP token 对应的 Metabase 账号权限。不要索取或暴露密码、Session、API Key。";

export const DEFAULT_MCP_SERVER_INSTRUCTIONS =
  "这是一个源数据只读的内部数据网关。回答普通数据问题时第一步必须用原始问题调用 search_assets。资产选择顺序是 Metric、Model、Card、Dashboard：只要匹配的 Metric 能通过既有公式和 dimensions 回答，就必须先 get_asset 检查并用 run_asset.semantic.filters/breakouts 运行 Metric，不得在 Model 上重新实现 count、distinct、sum 等聚合。只有逐个检查并明确说明所有候选 Metric 不适用的原因后，才能降级到 Model 聚合；此时 run_asset 必须携带 question、rejected_asset_ids 和 fallback_reason。Model 明细查询不受此限制。多个用户 Model 的交、并、差使用 query_audience；完整 UID 文件使用 export_audience。只有治理资产不适用或用户明确要求 SQL 时才回退 query_starrocks。字段必须来自元信息，所有查询只读且使用个人 MCP token 对应的 Metabase 权限。不要索取或暴露密码、Session、API Key。";

export const MCP_TOOL_DEFINITIONS = [
  { name: "search_assets", title: "搜索数据资产", category: "资产发现", riskLevel: "low", description: "普通数据问题必须首先调用；搜索已开放元信息，并按 Metric、Model、Card、Dashboard 的治理顺序提供推荐。", usageNotes: "必须把用户原始问题作为 query。先逐个检查匹配 Metric；只有 Metric 均不适用时才能降级到 Model。", inputSchema: { query: "string，用户原始问题或关键词，默认空字符串", platform: "metabase | posthog | local，可选", type: "dashboard | card | model | insight | metric | table | event，可选", domain: "string，业务域，可选", limit: "integer，返回数量" } },
  { name: "get_asset", title: "查看资产详情", category: "元信息", riskLevel: "low", description: "读取单个资产的完整元信息，包括链接、查询定义、字段、参数、Metric 公式/维度/依赖和警告。", usageNotes: "需要先通过 search_assets 获得统一资产 ID；Metabase 资产会使用个人 MCP token 对应账号实时校验权限。", inputSchema: { asset_id: "string，必填，例如 metabase:card:456、metabase:model:388 或 metabase:metric:480" } },
  { name: "trace_asset", title: "追踪资产来源", category: "元信息", riskLevel: "low", description: "查看资产的查询定义、字段、上游来源、引用资产和原始平台链接。", usageNotes: "用于解释数据出处、SQL、字段和上游依赖，不执行数据查询。", inputSchema: { asset_id: "string，必填" } },
  { name: "run_asset", title: "运行数据资产", category: "数据查询", riskLevel: "medium", description: "运行治理资产；服务端对 Model 聚合强制执行 Metric 优先检查。", usageNotes: "Metric 保持公式不变。Model 明细可直接查询；Model 聚合必须携带 question，存在匹配 Metric 时会被阻止，除非用 rejected_asset_ids 和 fallback_reason 明确完成降级。", inputSchema: { asset_id: "string，必填", question: "string，Model 聚合时必填，用户原始问题", rejected_asset_ids: "string[]，可选，已确认不适用的 Metric", fallback_reason: "string，可选，降级原因", params: "object，可选", semantic: "object，可选，仅 Metabase Model/Metric", limit: "integer，返回行数限制" } },
  { name: "query_audience", title: "组合用户人群", category: "数据查询", riskLevel: "medium", description: "按统一 uid 在 Metabase 内组合 2-10 个 Model，支持交集、并集和第一个 Model 减去其余 Model。", usageNotes: "先 search_assets/get_asset，并确认每个 Model 都包含 audience 元数据；默认 output=count。禁止分别运行 Model 后在客户端拼接 UID。", inputSchema: { operator: "intersection | union | difference", models: "array，2-10 个 {asset_id, filters?}", output: "count | uids，默认 count", limit: "integer，仅限制 uids 输出" } },
  { name: "export_audience", title: "导出用户人群", category: "数据导出", riskLevel: "high", description: "在 Metabase 内计算完整 UID 人群并生成有期限的服务端 CSV 下载文件。", usageNotes: "仅当用户明确要求完整 UID 文件时调用。超出服务端行数或字节限制会失败，不会静默截断；下载 URL 等同临时访问凭证，不得公开分享。", inputSchema: { operator: "intersection | union | difference", models: "array，2-10 个 {asset_id, filters?}", filename: "string，可选 CSV 文件名", max_rows: "integer，默认及上限由 AUDIENCE_EXPORT_MAX_ROWS 控制" } },
  { name: "query_starrocks", title: "查询 StarRocks", category: "数据查询", riskLevel: "high", description: "仅作为治理资产查询失败后的回退；服务端会根据原始问题再次检索 Metric/Model/Card，并在存在候选资产时阻止 SQL。", usageNotes: "必须传 question 和 purpose。普通问题使用 data_question；候选资产不适用时提交 rejected_asset_ids 与 fallback_reason；只有用户明确要求 SQL 才用 user_requested_sql。", inputSchema: { question: "string，必填，用户原始数据问题", sql: "string，必填，单条只读 SQL", purpose: "data_question | metadata_inspection | user_requested_sql", rejected_asset_ids: "string[]，可选，已检查且不适用的治理资产", fallback_reason: "string，可选，拒绝候选资产时必填", limit: "integer，返回行数限制" } },
  { name: "list_domains", title: "列出业务域", category: "资产发现", riskLevel: "low", description: "列出当前用户可见的已开放资产业务域。", usageNotes: "可用于帮助 AI 缩小 search_assets 的 domain 范围。", inputSchema: {} },
  { name: "catalog_status", title: "查看目录状态", category: "运行状态", riskLevel: "low", description: "查看已开放元信息数量、平台和类型统计以及同步新鲜度。", usageNotes: "用于排查搜索不到资产、同步过期或目录未初始化问题。", inputSchema: {} },
  { name: "auth_status", title: "查看授权状态", category: "认证", riskLevel: "low", description: "检查个人 MCP token 是否已映射到 Metabase 账号及可用 Session，不返回任何密钥。", usageNotes: "本地不按时间主动过期；只有缺少映射或 Metabase 实际拒绝 Session 时才需要重新授权。", inputSchema: {} },
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
       where setting_key = 'global_instructions' and setting_value = any($2::text[])`,
      [DEFAULT_MCP_SERVER_INSTRUCTIONS, [LEGACY_ENGLISH_MCP_SERVER_INSTRUCTIONS, LEGACY_USER_SESSION_MCP_SERVER_INSTRUCTIONS, LEGACY_SERVICE_ACCOUNT_MCP_SERVER_INSTRUCTIONS, LEGACY_PRE_METRIC_MCP_SERVER_INSTRUCTIONS, LEGACY_PRE_SEMANTIC_MCP_SERVER_INSTRUCTIONS, LEGACY_PRE_SQL_GOVERNANCE_MCP_SERVER_INSTRUCTIONS, LEGACY_PRE_AUDIENCE_MCP_SERVER_INSTRUCTIONS, LEGACY_PRE_EXPORT_MCP_SERVER_INSTRUCTIONS, LEGACY_PRE_METRIC_SELECTION_GOVERNANCE_MCP_SERVER_INSTRUCTIONS]]
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
