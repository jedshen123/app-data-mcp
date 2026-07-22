# App Data MCP

这是一个面向内部数据平台的 MCP 服务。Metabase、PostHog 等元信息同步到 PostgreSQL，由管理员在后台决定是否对 MCP 用户开放，让 Codex、Claude Code 等 AI 客户端完成资产发现、详情查看、数据出处追踪和受控取数。

## 当前能力

- `search_assets`: 搜索看板、卡片、Model、insight、指标、表、事件。
- `get_asset`: 查看单个资产完整元信息。
- `trace_asset`: 查看资产的 SQL / 事件 / 上游表 / 原始链接。
- `run_asset`: 只读返回支持资产的真实数据；不支持时读取本地 `sampleData` 兜底。
- `query_audience`: 使用统一 `uid` 对 2-10 个 Metabase Model 做交集、并集或差集计算。
- `export_audience`: 将完整 UID 人群导出为有期限的服务端 CSV 下载文件。
- `query_starrocks`: 治理资产无法回答后的受控 StarRocks SQL 回退；执行前会再次搜索 Metric/Model/Card。
- `list_domains`: 查看配置里已有的业务域。
- `auth_status`: 查看当前请求用户和 Metabase 授权状态。
- `catalog_status`: 查看 PostgreSQL 中已开放元信息的数量和分类统计。
- `connector_status`: 查看连接器配置状态和只读访问策略。

## 只读访问策略

这个 MCP 只做只读数据网关，不提供任何创建、更新、删除、写回能力。

允许的操作：

- 搜索和读取 PostgreSQL 中已开放的元信息。
- 读取看板、卡片、insight、指标口径和来源链接。
- 追踪上游表、事件、SQL、原平台 URL。
- 执行 Metabase/PostHog 查询时，只允许调用读取类 API，并限制为只读查询结果。
- 执行 StarRocks 查询时，只允许单条 `SELECT`、`WITH ... SELECT`、`SHOW`、`DESCRIBE/DESC` 或 `EXPLAIN`。

禁止的操作：

- 创建、编辑、删除 Metabase dashboard/card/question。
- 创建、编辑、删除 PostHog dashboard/insight/cohort/action。
- 写数据库、执行 DDL/DML、保存 AI 生成的 SQL 到平台。
- 通过 MCP 修改任何业务数据、平台配置或权限配置。

后续新增 connector 或 tool 时，命名和实现都必须维持这个边界。`connector_status` 会返回 `accessMode: "read-only"`，用于让 AI 客户端确认当前服务策略。

## 数据量限制

默认会限制返回数据量，避免 AI 平台一次拉取过大的结果。

- `search_assets` 默认返回 10 条，最多 50 条。
- `run_asset` 默认返回 100 行，最多 500 行。
- 单次 MCP 响应默认最大约 1 MB，超过会返回 `response_too_large`，提示缩小查询范围。
- `query_starrocks` 与 `run_asset` 共用行数上限；同时在 StarRocks 会话设置 `sql_select_limit` 和 `query_timeout`。

可以通过环境变量调整，但建议生产环境保持保守：

```bash
DATA_DEFAULT_SEARCH_LIMIT=10
DATA_MAX_SEARCH_LIMIT=50
DATA_DEFAULT_RESULT_ROW_LIMIT=100
DATA_MAX_RESULT_ROW_LIMIT=500
DATA_MAX_RESPONSE_BYTES=1000000
```

Metabase/PostHog connector 会继续在返回侧做行数和响应字节限制。`connector_status` 会返回当前 `dataLimits`。

## 真实数据读取

`run_asset` 现在会优先调用平台只读 API 获取真实数据：

- `metabase:card:*` / `metabase:model:*` / `metabase:metric:*`: 调用 Metabase card query endpoint；Model 和 Metric 在 Metabase API 中同样通过 card query 执行。
- `metabase:dashboard:*`: 读取 dashboard 下的卡片，并按 dashboard 筛选器映射逐个执行卡片查询。
- `posthog:insight:*`: 调用 PostHog insight read endpoint，并请求刷新/返回当前结果。

仍然不支持写入操作，也不会保存查询、修改看板或更新 insight。

注意：

- Dashboard 取数会限制最多执行 20 张卡片，可用 `DATA_MAX_DASHBOARD_CARDS` 调整。
- 每张卡片/insight 结果继续受 `DATA_MAX_RESULT_ROW_LIMIT` 和 `DATA_MAX_RESPONSE_BYTES` 限制。
- 资产声明了 `parameters` 时，可以给 `run_asset` 传维度/日期参数；未声明的友好参数会被拒绝，避免 AI 临时拼接不受控条件。
- Metabase dashboard 会读取 `parameter_mappings`，只把已经映射到对应 card 的筛选参数下发，并在返回里给出每张 card 的 `parameterMappingStatus`。
- 如果 live connector 失败且资产里配置了 `sampleData`，会回退返回 sampleData。
- 如果既无法 live 查询又没有 sampleData，会返回 `live_connector_failed` 或 `asset_not_runnable`。

Metabase 友好参数示例：

```json
{
  "asset_id": "metabase:card:81",
  "params": {
    "date": {
      "from": "2026-07-01",
      "to": "2026-07-09"
    },
    "country": "US"
  },
  "limit": 100
}
```

### Model / Metric 语义查询

`run_asset.semantic` 可以在不修改 Metabase 对象、不拼接 SQL 的情况下，对已经同步的 Model 和 Metric 进行受控分析。所有字段都必须来自 `get_asset` 返回的 Model `columns` 或 Metric `metric.dimensions`，服务端会校验字段引用、操作符、数量上限和数据类型。

Metric 保持已经治理的公式不变，只允许追加筛选和替换拆分维度：

```json
{
  "asset_id": "metabase:metric:480",
  "semantic": {
    "filters": [
      { "field": "country_ad_ch", "operator": "eq", "value": "CN" }
    ],
    "breakouts": [
      { "field": "data_source" },
      { "field": "date(t1.event_date)", "unit": "month" }
    ]
  },
  "limit": 100
}
```

传入 `"breakouts": []` 可以移除 Metric 的默认时间分组并返回总值；省略 `breakouts` 则保留 Metric 原有默认分组。

Model 可以选择明细字段：

```json
{
  "asset_id": "metabase:model:479",
  "semantic": {
    "fields": ["uid", "data_source", "date(t1.event_date)"],
    "filters": [
      { "field": "is_active_on_date", "operator": "eq", "value": 1 }
    ]
  },
  "limit": 100
}
```

也可以动态聚合和拆分：

```json
{
  "asset_id": "metabase:model:479",
  "semantic": {
    "filters": [
      { "field": "is_active_on_date", "operator": "eq", "value": 1 }
    ],
    "aggregations": [
      { "operator": "distinct", "field": "uid", "alias": "有效用户数" }
    ],
    "breakouts": [
      { "field": "data_source" }
    ]
  },
  "limit": 100
}
```

筛选操作符包括 `eq`、`neq`、`gt`、`gte`、`lt`、`lte`、`in`、`not_in`、`contains`、`is_null`、`not_null`、`between`；聚合包括 `count`、`distinct`、`sum`、`avg`、`min`、`max`。语义查询与 `params` 不能同时使用，Card、Dashboard 和 PostHog Insight 不接受 `semantic`。

### 用户人群组合查询

Metabase 同步会为包含 `uid` 字段的 Model 生成 `audience` 元数据。`query_audience` 要求所有输入 Model 位于同一个 Metabase database，并使用当前用户的 Metabase Session 在 `/api/dataset` 内完成集合计算。每个 Model 会先在数据源侧应用筛选并按 `uid` 去重，再执行集合连接，不会先把各 Model 的 UID 拉回 MCP 客户端。

```json
{
  "operator": "intersection",
  "models": [
    {
      "asset_id": "metabase:model:101",
      "filters": [
        { "field": "event_time", "operator": "gte", "value": "2026-07-01" }
      ]
    },
    {
      "asset_id": "metabase:model:102",
      "filters": [
        { "field": "topic", "operator": "eq", "value": "母婴" }
      ]
    }
  ],
  "output": "count",
  "limit": 100
}
```

`operator` 支持 `intersection`、`union` 和 `difference`；`difference` 表示第一个 Model 减去后续所有 Model。`output=count` 默认只返回去重用户数；`output=uids` 返回去重 UID，并受全局最大行数和响应大小限制。每个 Model 最多包含 20 个受控语义筛选条件。

需要完整 UID 文件时使用 `export_audience`，不要循环调用有限的 `query_audience` 结果：

```json
{
  "operator": "intersection",
  "models": [
    { "asset_id": "metabase:model:493", "filters": [{ "field": "deleted", "operator": "eq", "value": 0 }] },
    { "asset_id": "metabase:model:496", "filters": [{ "field": "status", "operator": "eq", "value": 1 }] }
  ],
  "filename": "community-active-users.csv"
}
```

服务端通过 Metabase CSV endpoint 获取完整的单列 UID 结果，生成随机 capability 下载地址，默认 24 小时后失效，并由后台定时清理。超过行数或文件字节上限时整个导出失败，不会生成截断文件。下载地址相当于临时访问凭证，不应公开分享。

### 治理资产优先与 SQL 回退

普通数据问题必须先调用 `search_assets`。搜索支持直接传入中文长句，会拆分中文二元/三元语义片段，并按 `Metric > Model > Card > Dashboard` 返回候选；同类型资产仍保持相关度顺序。返回值中的 `selection.recommendedAssetId`、`candidateOrder`，以及每项资产的 `selection.rank/typePriority/recommended` 会明确告诉 AI 应先检查哪个资产。只有管理后台已开放且有效的资产会参与搜索和治理检查。

当 AI 在 Model 上使用 `semantic.aggregations` 重新计算 `count`、`distinct`、`sum` 等指标时，`run_asset` 会进行第二次服务端检查：

- 必须传入用户原始 `question`，否则返回 `asset_question_required`。
- 如果仍有匹配 Metric，返回 `higher_priority_metric_available` 并拒绝执行 Model。
- AI 必须逐个 `get_asset` 检查候选 Metric；确认不适用后，把所有相关 ID 放入 `rejected_asset_ids` 并提供具体 `fallback_reason`。
- 拒绝 Metric 却不说明原因时返回 `fallback_reason_required`。
- Model 的 `semantic.fields` 明细查询不属于重新计算指标，不受这项拦截影响。

例如只有在治理 Metric 缺少用户要求的维度时，才允许这样显式降级：

```json
{
  "asset_id": "metabase:model:492",
  "question": "查询按实验分组拆分的中国地区绑定设备用户数",
  "rejected_asset_ids": ["metabase:metric:483"],
  "fallback_reason": "Metric 483 没有实验分组维度",
  "semantic": {
    "filters": [{ "field": "country_ad_ch", "operator": "eq", "value": "中国" }],
    "aggregations": [{ "operator": "distinct", "field": "uid", "alias": "user_count" }],
    "breakouts": [{ "field": "experiment_group" }]
  }
}
```

`query_starrocks` 要求同时传入用户原始问题，并在执行 SQL 前由服务端再次搜索治理资产：

```json
{
  "question": "最近15天有效绑定M9设备的社区活跃用户数趋势",
  "sql": "select ...",
  "purpose": "data_question",
  "limit": 100
}
```

如果存在匹配的 Metric/Model/Card，服务端返回 `governed_assets_available`、候选资产和下一步说明，且 `sqlExecuted=false`。AI 应先使用 `get_asset` 和 `run_asset`。检查后确认候选资产不适用，才可显式拒绝并回退：

```json
{
  "question": "最近15天有效绑定M9设备的社区活跃用户数趋势",
  "sql": "select ...",
  "purpose": "data_question",
  "rejected_asset_ids": ["metabase:metric:480", "metabase:model:479"],
  "fallback_reason": "候选资产没有所需的实验组字段",
  "limit": 100
}
```

`purpose=user_requested_sql` 只能用于用户明确要求直接执行 SQL 的场景；`purpose=metadata_inspection` 只允许 `SHOW`、`DESCRIBE/DESC` 和 `EXPLAIN`。

Metabase dashboard 参数执行结果会包含筛选器覆盖情况：

```json
{
  "requestedParameters": ["date", "country"],
  "parameterCoverage": [
    {
      "parameter": "date",
      "mappedCardCount": 3,
      "mappedCards": [
        {
          "cardId": "81",
          "title": "APP 日活"
        }
      ]
    }
  ],
  "cards": [
    {
      "cardId": "81",
      "parameterMappingStatus": {
        "status": "partially_mapped",
        "requestedParameters": ["date", "country"],
        "appliedParameters": ["date"],
        "unmappedParameters": ["country"],
        "mappedParametersAvailable": ["date"]
      }
    }
  ]
}
```

Metabase 原生参数仍可透传：

```json
{
  "asset_id": "metabase:card:81",
  "params": {
    "parameters": [
      {
        "type": "date/range",
        "target": ["variable", ["template-tag", "date"]],
        "value": "2026-07-01~2026-07-09"
      }
    ]
  }
}
```

PostHog insight 支持常见只读覆盖参数：

```json
{
  "asset_id": "posthog:insight:abc123",
  "params": {
    "date_from": "-30d",
    "date_to": "now",
    "breakdown": "country",
    "properties": [
      {
        "key": "country",
        "value": "US",
        "operator": "exact",
        "type": "event"
      }
    ]
  }
}
```

## StarRocks 自助 SQL

`query_starrocks` 仅用于治理资产无法回答问题后的 SQL 回退。服务端强制执行下面的顺序：

1. 必须先调用 `search_assets`，优先检查 Metric、Model，再检查 Card、Dashboard 或 Insight。
2. 能由治理资产回答时使用 `get_asset` 和 `run_asset`。
3. 没有合适资产、已明确拒绝候选资产，或用户明确要求 SQL 时，才使用 `query_starrocks`。
4. 不熟悉表结构时，先执行 `SHOW TABLES`、`DESCRIBE table_name` 或 `SHOW CREATE TABLE table_name`。
5. 根据真实字段生成带明确日期范围和过滤条件的 `SELECT`，避免扫描无关数据。

示例：

```json
{
  "question": "最近15天活跃用户数趋势",
  "sql": "SELECT dt, count(*) AS active_users FROM ads_app_daily WHERE dt >= '2026-07-01' GROUP BY dt ORDER BY dt",
  "purpose": "data_question",
  "limit": 100
}
```

服务会拒绝 DDL、DML、多语句、`INTO OUTFILE`、`LOAD_FILE`、`FILES`、`SLEEP`、可执行注释和自定义查询 Hint 等危险或消耗型 SQL。每次执行还会设置 StarRocks 当前会话的查询超时与最大返回行数，并继续受 MCP 响应字节数限制。

StarRocks 配置放在 `.env`，不要写入元信息表：

```bash
STARROCKS_HOST=127.0.0.1
STARROCKS_PORT=9030
STARROCKS_USER=app_data_mcp_reader
STARROCKS_PASSWORD=your-password
STARROCKS_DATABASE=your_database
STARROCKS_CONNECTION_LIMIT=10
STARROCKS_CONNECT_TIMEOUT_MS=10000
STARROCKS_QUERY_TIMEOUT_MS=30000
STARROCKS_MAX_SQL_LENGTH=50000
STARROCKS_SSL=false
```

必须使用专用只读账号。MCP token 负责识别和审计查询人，真正的数据表权限由这个 StarRocks 账号控制。管理员可以按实际数据库创建最小权限账号，例如：

```sql
CREATE USER 'app_data_mcp_reader' IDENTIFIED BY 'replace-with-a-strong-password';
GRANT SELECT ON ALL TABLES IN DATABASE your_database TO USER 'app_data_mcp_reader';
GRANT SELECT ON ALL VIEWS IN DATABASE your_database TO USER 'app_data_mcp_reader';
```

不要给该账号授予 `INSERT`、`UPDATE`、`DELETE`、`CREATE`、`DROP`、`ALTER`、`EXPORT` 或管理角色。配置后可先调用 `connector_status` 确认 `starrocks.configured=true`，再让 AI 执行 `SHOW TABLES` 验证连接。

## 本地运行

第一次部署先配置 PostgreSQL。服务或同步脚本首次访问时会自动创建 `DB_SCHEMA.METADATA_TABLE`，默认是 `public.app_data_mcp_assets`。

stdio 模式，适合本机 Codex / Claude Code 通过命令启动：

```bash
npm install
npm run dev
```

HTTP 模式，适合部署成团队共享服务：

```bash
npm run dev:http
```

默认地址：

```text
http://127.0.0.1:3000/mcp
```

健康检查：

```text
http://127.0.0.1:3000/health
```

如果还没有同步并开放任何资产，`catalog_status` 会显示 `assetCount: 0`，`search_assets` 会返回空列表。先运行同步脚本，再打开 `http://127.0.0.1:3000/admin` 使用 Metabase 管理员账号登录并勾选开放。

## 同步平台元信息

可以运行只读同步脚本，把 Metabase/PostHog 元信息 upsert 到 PostgreSQL。

同步 Metabase：

```bash
npm run sync:metabase
```

同步 PostHog：

```bash
npm run sync:posthog
```

全部同步：

```bash
npm run sync:all
```

同步脚本只读取平台 API，然后更新元信息表：

- 已存在的资产更新 `metadata` 和同步时间，不覆盖管理员设置的 `is_published` 和人工配置。
- 新资产默认 `is_published=false`；可通过 `METADATA_DEFAULT_PUBLISHED=true` 调整，但生产环境不建议。
- 平台中已经消失的资产会标记为 inactive，并自动设置 `is_published=false`，不再对 MCP 暴露；未来重新同步出现时也不会自动恢复开放。
- 不会创建、更新、删除 Metabase/PostHog 平台内的任何对象。

Metabase 同步会为 dashboard/card/model/metric 写入权限快照 `asset.access`，包括 collection、creator、archived、personal collection、同步时间等。MCP 使用两级过滤：

Card、Model 与 Metric 同步会在读取 `/api/card` 列表后，以受限并发继续读取 `/api/card/:id` 详情，并优先使用详情中的 `dataset_query`、`result_metadata`、参数和更新时间。Model 保存为 `metabase:model:<id>`，Metric 保存为 `metabase:metric:<id>`。包含 `uid` 的 Model 会额外保存 `audience` 元数据和 database id，用于服务端人群组合查询。Metric 还会保存公式、筛选条件、数据来源、默认时间维度、可拆分维度和上下游资产依赖；字段元信息区分 `name`、`displayName` 与真实 `description`。对象在 Card、Model、Metric 之间转换时，会迁移原记录并保留开放状态和后台人工配置。详情请求失败时会保留列表数据，并在同步日志和资产 `warnings` 中标记。

- `search_assets` / `list_domains`: 用本地权限快照快速过滤归档资产和非本人 personal collection。
- `get_asset` / `trace_asset`: 先做本地快照过滤，再用当前用户 Metabase session 实时请求 `GET /api/card/:id` 或 `GET /api/dashboard/:id` 校验可见性。
- `run_asset`: 继续使用用户 Metabase session 执行只读查询，保留平台实时权限判断。
- `query_audience`: 对每个输入 Model 做快照和实时权限校验，再使用同一用户 Session 执行组合查询。

部署或升级后执行一次完整同步：

```bash
npm run sync:metabase
```

同步频率建议：

```bash
METABASE_METADATA_SYNC_INTERVAL_HOURS=6
METABASE_PERMISSION_SYNC_INTERVAL_HOURS=6
POSTHOG_METADATA_SYNC_INTERVAL_HOURS=12
```

如果 Metabase 权限、collection、核心看板变化频繁，可以把 Metabase 调整到 1 小时；如果变化少，6 小时通常够用。权限大调整、核心看板发布后建议手动运行：

```bash
npm run sync:metabase
```

生产环境可以用 cron 或调度器定时执行：

```cron
0 */6 * * * cd /path/to/app-data-mcp && npm run sync:metabase
15 */12 * * * cd /path/to/app-data-mcp && npm run sync:posthog
```

`catalog_status` 会返回 metadata/access snapshot 的 `latestSyncedAt`、`ageHours` 和 `stale`，超过上述间隔时会提示重新同步。

如果同步失败，常见原因是 `.env` 里平台地址或凭据未填完整。可以先在 MCP 里调用 `connector_status` 检查配置。

HTTP 模式可配置：

```bash
MCP_HTTP_HOST=0.0.0.0 MCP_HTTP_PORT=3000 npm run dev:http
```

`MCP_HTTP_BEARER_TOKEN` 是旧的共享 HTTP 保护 token。多人使用时更推荐后面的“Metabase 用户授权”流程，由每位用户登录后生成自己的个人 MCP token。

如果仍设置 `MCP_HTTP_BEARER_TOKEN`，客户端需要带共享 token 或用户个人 token 才能进入 `/mcp`。共享 token 只做传输入口保护；当 `APP_DATA_REQUIRE_AUTH_TOKEN=true` 时，数据类 tools 仍然需要用户个人 token 才能识别具体权限。

```text
Authorization: Bearer <token>
```

## Codex / Claude Code 配置示例

stdio：

```json
{
  "mcpServers": {
    "app-data": {
      "command": "npm",
      "args": ["run", "dev"],
      "cwd": "/Users/lute/code/app-data-mcp"
    }
  }
}
```

HTTP / Streamable HTTP：

```json
{
  "mcpServers": {
    "app-data": {
      "url": "http://127.0.0.1:3000/mcp",
      "headers": {
        "Authorization": "Bearer appdata_your-personal-token"
      }
    }
  }
}
```

不同 AI 平台的配置字段名可能略有差异，但核心就是把 MCP endpoint 指到 `/mcp`。

## Metabase / PostHog API 配置

不要把 API key、用户名、密码写入元信息表。密钥只通过部署环境变量提供。

复制 `.env.example` 为 `.env`，在部署环境里填写：

```bash
METABASE_BASE_URL=https://metabase.example.com
METABASE_PUBLIC_URL=https://metabase.example.com
METABASE_API_KEY=...

POSTHOG_BASE_URL=https://posthog.example.com
POSTHOG_PROJECT_ID=...
POSTHOG_PERSONAL_API_KEY=...
```

`run_asset` 会使用这些环境变量调用 Metabase/PostHog 只读 API。资产不可 live 查询或连接失败时，才会按配置回退到本地 `sampleData`。

`METABASE_BASE_URL` 是 MCP 服务端访问 Metabase API 的地址；`METABASE_PUBLIC_URL` 是返回给 AI 用户点击的数据来源地址。远程部署时如果服务端通过本机端口访问 Metabase，例如：

```bash
METABASE_BASE_URL=http://127.0.0.1:3000
METABASE_PUBLIC_URL=http://54.226.190.74:3000
```

这样 MCP 查询仍走服务器本地 API，但返回的 `asset.url` / `source.url` 会是远程可访问地址。修改后建议重新运行 `npm run sync:metabase`；即使暂时不重同步，服务读取时也会按 `METABASE_PUBLIC_URL` 重写 Metabase 来源链接。

如果没有拿到 `METABASE_API_KEY`，可以用 Metabase 用户名密码：

```bash
METABASE_BASE_URL=https://metabase.example.com
METABASE_USER=your-user@example.com
METABASE_PASS=your-password
```

Metabase connector 会用这组配置调用 `POST /api/session` 换取 session id，再用 `X-Metabase-Session` 请求 dashboard/card API。也兼容旧变量名 `METABASE_USERNAME` 和 `METABASE_PASSWORD`。

可以通过 MCP tool `connector_status` 检查配置是否齐全；它只返回是否配置和认证模式，不返回密钥或密码。

## Metabase 用户授权与后台管理员登录

每个用户配置个人 MCP token，服务端用 token 反查对应的 Metabase 账号和 Session，并严格按该账号权限查询：

```bash
METABASE_BASE_URL=https://app-data.luteos.site
METABASE_LOGIN_URL=https://app-data.luteos.site
METABASE_AUTH_MODE=user-session
METABASE_ALLOW_SERVICE_FALLBACK=false
APP_DATA_MCP_PUBLIC_BASE_URL=http://127.0.0.1:3000
APP_DATA_REQUIRE_AUTH_TOKEN=true
APP_DATA_SESSION_FILE=.data/metabase-sessions.json
```

个人 MCP token 本身不按时间过期，MCP 也不再使用 `METABASE_SESSION_TTL_HOURS` 主动判定底层 Session 过期。只要 Metabase 接受该 Session，服务就持续使用它。只有 Metabase 实际返回 HTTP 401 时，才返回 `reauth_required`，要求对应账号重新授权以替换平台 Session；同一账号重新授权时会生成新的个人 MCP token，并立即使该账号之前的 token 失效，也不会自动切换到统一服务账号绕过用户权限。

用户首次授权打开：

```text
http://127.0.0.1:3000/auth/metabase/login
```

授权后将页面生成的 `Authorization: Bearer appdata_xxx` 配置到 AI 助手。服务端只保存 token 哈希和 Metabase Session，不保存用户密码。

管理后台仍然要求使用 Metabase 管理员账号登录：

```text
http://127.0.0.1:3000/admin
```

只保存随机后台 Session 的哈希、CSRF token 和管理员邮箱到 PostgreSQL，不保存管理员密码。设置 `ADMIN_SESSION_PERSISTENT=true` 后，后台 Session 默认不设置服务端过期时间，并在管理员访问后台时滚动刷新浏览器 Cookie；服务重启不会要求重新登录。主动退出、清理数据库 Session 或浏览器清除 Cookie 后仍需重新登录。

## 审计日志

MCP tool 调用会写入 Postgres 审计表，默认表名：

```text
public.app_data_mcp_audit_logs
```

本地配置示例：

```bash
AUDIT_LOG_ENABLED=true
AUDIT_LOG_TABLE=app_data_mcp_audit_logs
DB_TYPE=postgres
DB_HOST=127.0.0.1
DB_PORT=5432
DB_USER=superset
DB_PASSWORD=123456
DB_NAME=cubecore
DB_SCHEMA=public
DB_SSL=false
DB_SSL_REJECT_UNAUTHORIZED=true
DB_SSL_CA_FILE=
```

Amazon RDS 等要求加密连接的 PostgreSQL 需要设置：

```bash
DB_SSL=true
DB_SSL_REJECT_UNAUTHORIZED=true
DB_SSL_CA_FILE=/path/to/global-bundle.pem
```

`DB_SSL_CA_FILE` 应指向数据库服务商提供的 CA bundle。仅在临时排障且无法立即安装 CA 时，可以设置 `DB_SSL_REJECT_UNAUTHORIZED=false`；连接仍会加密，但不会验证数据库服务器证书身份，不建议长期使用。

服务首次写入时会自动执行 `create table if not exists`，表名前缀为 `app_data_mcp_`，避免和业务表冲突。已存在的审计表会自动补新增列。审计日志记录：

- 用户邮箱、鉴权方式、AI 助手平台、request id、IP、user agent。
- tool 名称、asset id、平台、资产类型、搜索词、limit。
- 对 `query_starrocks` 记录 SQL 文本、默认数据库和 SQL limit，便于追责与排障。
- 参数哈希，不记录完整参数明文。
- 返回行数、返回字节数、耗时、状态、错误摘要。

AI 助手平台优先读取请求头：

```text
X-App-Data-Client: claude-code
```

如果客户端没有传这个请求头，服务会尝试从 `user_agent` 推断，无法识别时记录为 `unknown`。

不会记录完整数据结果，也不会记录用户密码、Metabase session、个人 MCP token 明文。

查看最近调用：

```sql
select
  created_at,
  user_email,
  ai_client,
  tool_name,
  asset_id,
  status,
  row_count,
  duration_ms,
  error_code
from public.app_data_mcp_audit_logs
order by created_at desc
limit 50;
```

如果要临时关闭审计：

```bash
AUDIT_LOG_ENABLED=false
```

PostHog 同步脚本访问的是 private API，例如 dashboards 和 insights，需要 Personal API key。不要使用 Project API key / project token。`POSTHOG_API_KEY` 仍作为兼容别名支持，但建议新配置统一使用：

```bash
POSTHOG_PERSONAL_API_KEY=phx_...
```

## 资产 ID 规范

建议使用统一 ID，避免 AI 客户端理解不同平台的内部 ID：

- `metabase:dashboard:101`
- `metabase:card:456` 或 `metabase:model:388`
- `posthog:dashboard:abc`
- `posthog:insight:activation-funnel`
- `metric:activation_rate`

## 后台管理与元信息配置

HTTP 服务启动后访问：

```text
http://127.0.0.1:3000/admin
```

后台使用 Metabase 账号登录，并通过 `/api/user/current` 校验 `is_superuser=true`。管理员可以：

- 在 Metabase、PostHog 导航中查看同步状态和元信息。
- 勾选或取消 `is_published`，也可以选择多条后批量开放或关闭；变更会立即影响 MCP 搜索和读取。
- 点击列表字段标题可按开放状态、标题、类型、业务域、有效状态和同步时间排序。
- Metabase、PostHog 和审计列表使用固定默认列宽；拖拽表头右侧分隔线可调整列宽，结果保存在当前浏览器。
- 业务域使用可搜索组合框，支持输入过滤候选项；也可按资产类型和开放状态筛选，并与关键词搜索、排序和分页组合使用。
- 编辑标题、描述、业务域和标签；人工配置保存在 `admin_overrides`，后续同步不会覆盖。
- 在详情弹窗查看 URL、SQL/查询定义、字段、参数、Dashboard 映射、血缘、权限快照、警告、样例数据和完整 JSON；同步字段只读。
- 在审计导航查看 `AUDIT_LOG_TABLE` 中的用户、AI 客户端、tool、资产、状态、行数和耗时。
- 在 MCP 工具管理导航查看工具名称、分类、风险、详情描述和开放状态；关闭后工具不会出现在新 MCP 连接的 `tools/list` 中。
- MCP 工具管理页可查看和编辑连接时发送给 AI 的中文全局 `instructions`，并在工具详情中查看调用时机和参数说明；工具标识和参数名保留英文，确保客户端能准确调用。
- 实际发送给 AI 的说明会自动附加当前未开放工具清单；`query_starrocks` 关闭时会明确要求 AI 提示“SQL 查询工具未开放”，并与“StarRocks 连接器未配置”区分。

管理员登录会话持久化到 PostgreSQL 的 `app_data_mcp_admin_sessions` 表。浏览器 Cookie 只保存随机令牌，数据库只保存令牌哈希；服务重启后在有效期内无需重新登录。默认有效期为 168 小时，可配置：

```bash
ADMIN_SESSION_TTL_HOURS=168
ADMIN_SESSION_TABLE=app_data_mcp_admin_sessions
```

元信息表默认名为 `public.app_data_mcp_assets`，主要字段包括 `asset_id`、`platform`、`metadata jsonb`、`admin_overrides jsonb`、`is_published`、`is_active` 和同步时间。`metadata` 内的核心内容包括：

- `title` / `description`: 给 AI 搜索和理解使用。
- `businessDomain` / `tags`: 用于业务域过滤和召回。
- `url`: 必填，保证每个结果都有原始出处。
- `queryText`: SQL、PostHog insight 描述或指标口径。
- `columns`: 字段说明。
- `parameters`: 可传给 `run_asset` 的只读参数说明，例如日期、国家、渠道、PostHog properties 等。
- `dashboardParameterMappings`: Metabase dashboard 筛选器到下属 card 的映射关系，用于判断某个筛选参数是否会真正影响某张 card。
- `sourceRefs`: 上游表、事件、引用资产等血缘信息。
- `sampleData`: 本地样例数据；live connector 失败或不支持时可作为兜底。
- `warnings`: 数据延迟、口径注意事项、MVP 限制。

MCP 工具配置默认保存在 `public.app_data_mcp_tools`，全局说明保存在 `public.app_data_mcp_settings`；可以通过 `MCP_TOOLS_TABLE` 和 `MCP_SETTINGS_TABLE` 修改表名。HTTP 模式每次建立 MCP 服务时读取最新开关和说明；stdio 或已经建立的长连接需要重新连接后才会更新。

## 下一步建议

1. 接入 momcozy-data-agent 的受控语义层查询 API，作为 Metabase/PostHog curated assets 的 fallback。
2. 增加 token 自助吊销/轮换页面。
3. 增加敏感字段脱敏策略。
4. 根据你们实际口径补充指标 registry 和数据负责人信息。
