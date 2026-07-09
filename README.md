# App Data MCP

这是一个面向内部数据平台的 MCP 服务 MVP。当前版本先把 Metabase、PostHog、指标等元信息同步到本地配置文件，让 Codex、Claude Code 等 AI 客户端可以先完成资产发现、详情查看、数据出处追踪和样例取数。

## 当前能力

- `search_assets`: 搜索看板、卡片、insight、指标、表、事件。
- `get_asset`: 查看单个资产完整元信息。
- `trace_asset`: 查看资产的 SQL / 事件 / 上游表 / 原始链接。
- `run_asset`: 只读返回支持资产的真实数据；不支持时读取本地 `sampleData` 兜底。
- `list_domains`: 查看配置里已有的业务域。
- `auth_status`: 查看当前请求用户和 Metabase 授权状态。
- `catalog_status`: 查看本地元信息配置是否已初始化、资产数量和分类统计。
- `connector_status`: 查看连接器配置状态和只读访问策略。

## 只读访问策略

这个 MCP 只做只读数据网关，不提供任何创建、更新、删除、写回能力。

允许的操作：

- 搜索和读取本地元信息。
- 读取看板、卡片、insight、指标口径和来源链接。
- 追踪上游表、事件、SQL、原平台 URL。
- 执行 Metabase/PostHog 查询时，只允许调用读取类 API，并限制为只读查询结果。

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

可以通过环境变量调整，但建议生产环境保持保守：

```bash
DATA_DEFAULT_SEARCH_LIMIT=10
DATA_MAX_SEARCH_LIMIT=50
DATA_DEFAULT_RESULT_ROW_LIMIT=100
DATA_MAX_RESULT_ROW_LIMIT=500
DATA_MAX_RESPONSE_BYTES=1000000
```

后续接真实 Metabase/PostHog connector 时，也必须把这些限制下推到 API 查询参数或结果截断逻辑里。`connector_status` 会返回当前 `dataLimits`。

## 真实数据读取

`run_asset` 现在会优先调用平台只读 API 获取真实数据：

- `metabase:card:*`: 调用 Metabase card query endpoint。
- `metabase:dashboard:*`: 读取 dashboard 下的卡片，并逐个执行卡片查询。
- `posthog:insight:*`: 调用 PostHog insight read endpoint，并请求刷新/返回当前结果。

仍然不支持写入操作，也不会保存查询、修改看板或更新 insight。

注意：

- Dashboard 取数会限制最多执行 20 张卡片，可用 `DATA_MAX_DASHBOARD_CARDS` 调整。
- 每张卡片/insight 结果继续受 `DATA_MAX_RESULT_ROW_LIMIT` 和 `DATA_MAX_RESPONSE_BYTES` 限制。
- 如果 live connector 失败且资产里配置了 `sampleData`，会回退返回 sampleData。
- 如果既无法 live 查询又没有 sampleData，会返回 `live_connector_failed` 或 `asset_not_runnable`。

## 本地运行

第一次部署先初始化本地元信息配置：

```bash
npm run init:assets
```

这会创建空的 `config/assets.json`。如果文件已经存在，不会覆盖。需要强制重置为空文件时：

```bash
npm run init:assets:force
```

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

默认读取 `config/assets.json`。也可以通过环境变量指定：

```bash
DATA_ASSETS_FILE=/path/to/assets.json npm run dev
```

如果还没有从 Metabase/PostHog 同步到任何资产，MCP 仍然可以启动；`catalog_status` 会显示 `assetCount: 0`，`search_assets` 会返回空列表。此时需要先手工往 `config/assets.json` 填元信息，或后续运行平台同步脚本。

## 同步平台元信息

初始化配置文件后，可以运行只读同步脚本，把 Metabase/PostHog 元信息写入本地 `config/assets.json`。

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

同步脚本只读取平台 API，然后更新本地配置文件：

- `sync:metabase` 只替换 `platform: "metabase"` 的资产。
- `sync:posthog` 只替换 `platform: "posthog"` 的资产。
- `platform: "local"` 的本地指标口径会保留。
- 不会创建、更新、删除 Metabase/PostHog 平台内的任何对象。

Metabase 同步会为 dashboard/card 写入本地权限快照 `asset.access`，包括 collection、creator、archived、personal collection、同步时间等。MCP 使用两级过滤：

- `search_assets` / `list_domains`: 用本地权限快照快速过滤归档资产和非本人 personal collection。
- `get_asset` / `trace_asset`: 先做本地快照过滤，再用当前用户 Metabase session 实时请求 `GET /api/card/:id` 或 `GET /api/dashboard/:id` 校验可见性。
- `run_asset`: 继续使用用户 Metabase session 执行只读查询，保留平台实时权限判断。

升级到权限快照版本后，已有 `config/assets.json` 里的旧 Metabase 资产不会自动拥有 `asset.access`，需要重新执行一次：

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
      "cwd": "/Users/lute/code/app-data-mcp",
      "env": {
        "DATA_ASSETS_FILE": "config/assets.json"
      }
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

不要把 API key、用户名、密码写进 `config/assets.json`。元信息 JSON 只放可给 AI 使用的资产描述、链接、字段、血缘和样例数据。

复制 `.env.example` 为 `.env`，在部署环境里填写：

```bash
METABASE_BASE_URL=https://metabase.example.com
METABASE_API_KEY=...

POSTHOG_BASE_URL=https://posthog.example.com
POSTHOG_PROJECT_ID=...
POSTHOG_PERSONAL_API_KEY=...
```

当前 MVP 还没有真正调用 Metabase/PostHog API，`run_asset` 读取的是 `sampleData`。这些环境变量是给下一步 connector 使用的统一入口。

如果没有拿到 `METABASE_API_KEY`，可以用 Metabase 用户名密码：

```bash
METABASE_BASE_URL=https://metabase.example.com
METABASE_USER=your-user@example.com
METABASE_PASS=your-password
```

后续 Metabase connector 会用这组配置调用 `POST /api/session` 换取 session id，再用 `X-Metabase-Session` 请求 dashboard/card API。也兼容旧变量名 `METABASE_USERNAME` 和 `METABASE_PASSWORD`。

可以通过 MCP tool `connector_status` 检查配置是否齐全；它只返回是否配置和认证模式，不返回密钥或密码。

## Metabase 用户授权

多人使用时，推荐复用 Metabase 用户权限。配置为：

```bash
METABASE_BASE_URL=https://app-data.luteos.site
METABASE_LOGIN_URL=https://app-data.luteos.site
METABASE_AUTH_MODE=user-session
METABASE_ALLOW_SERVICE_FALLBACK=false
METABASE_SESSION_TTL_HOURS=168
APP_DATA_SESSION_FILE=.data/metabase-sessions.json
APP_DATA_MCP_PUBLIC_BASE_URL=http://127.0.0.1:3000
APP_DATA_REQUIRE_AUTH_TOKEN=true
```

用户首次使用前打开：

```text
http://127.0.0.1:3000/auth/metabase/login
```

输入 `https://app-data.luteos.site` 的 Metabase 账号密码。MCP 会调用 Metabase `POST /api/session`，只保存用户 session，不保存密码。

授权成功后，页面会展示一次个人 MCP token：

```text
Authorization: Bearer appdata_xxx
```

服务端只保存这个 token 的哈希，并用 token 反查真实用户邮箱，再使用该用户的 Metabase session 查询数据。这样其他人即使知道某个同事邮箱，也不能冒用他的权限。

如果没有有效的个人 MCP token，数据类 tools 会直接返回 `auth_required`，不会搜索资产或执行查询。允许匿名使用时可以设置：

```bash
APP_DATA_REQUIRE_AUTH_TOKEN=false
```

Claude Code 示例：

```bash
claude mcp add --transport http app-data http://127.0.0.1:3000/mcp \
  --header "Authorization: Bearer appdata_your-personal-token" \
  --header "X-App-Data-Client: claude-code"
```

Codex `~/.codex/config.toml` 示例：

```toml
[mcp_servers.app-data]
url = "http://127.0.0.1:3000/mcp"
http_headers = { "Authorization" = "Bearer appdata_your-personal-token", "X-App-Data-Client" = "codex" }
enabled = true
tool_timeout_sec = 120
```

接入后可以先让 AI 调用：

```text
auth_status
```

如果未授权，返回中会包含 `loginUrl` 和下一步操作。MCP server instructions 也会提示 AI：执行 Metabase 真实取数前先检查 `auth_status`，不要在对话里索要密码。

如果 AI 平台能直接转发用户 Metabase session，也可以带：

```text
X-Metabase-Session: <user-metabase-session>
```

Metabase 查询优先级：

1. 请求里的 `X-Metabase-Session`
2. `.data/metabase-sessions.json` 中保存的用户 session
3. 服务账号 fallback，仅当 `METABASE_ALLOW_SERVICE_FALLBACK=true`

当 `METABASE_AUTH_MODE=user-session` 或 `METABASE_ALLOW_SERVICE_FALLBACK=false` 时，没有用户 session 会返回 `reauth_required` 和登录链接。

注意：`.data/metabase-sessions.json` 含有用户 session，已经被 `.gitignore` 忽略。生产环境建议改成 Redis、数据库或加密存储。

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
```

服务首次写入时会自动执行 `create table if not exists`，表名前缀为 `app_data_mcp_`，避免和业务表冲突。已存在的审计表会自动补新增列。审计日志记录：

- 用户邮箱、鉴权方式、AI 助手平台、request id、IP、user agent。
- tool 名称、asset id、平台、资产类型、搜索词、limit。
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
- `metabase:card:456`
- `posthog:dashboard:abc`
- `posthog:insight:activation-funnel`
- `metric:activation_rate`

## 元信息配置

核心配置在 `config/assets.json`：

- `title` / `description`: 给 AI 搜索和理解使用。
- `businessDomain` / `tags`: 用于业务域过滤和召回。
- `url`: 必填，保证每个结果都有原始出处。
- `queryText`: SQL、PostHog insight 描述或指标口径。
- `columns`: 字段说明。
- `sourceRefs`: 上游表、事件、引用资产等血缘信息。
- `sampleData`: MVP 阶段的本地样例数据，供 `run_asset` 返回。
- `warnings`: 数据延迟、口径注意事项、MVP 限制。

## 下一步建议

1. 用脚本从 Metabase API 同步 dashboard/card/question 元信息到 `config/assets.json`。
2. 用脚本从 PostHog API 同步 dashboard/insight/event 元信息到 `config/assets.json`。
3. 增加用户身份、权限过滤、审计日志和敏感字段脱敏。
4. 根据你们实际口径补充指标 registry 和数据负责人信息。
