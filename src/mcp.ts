import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  canReadAssetMetadataFromSnapshot,
  canReadAssetMetadataLive,
  filterAssetsBySnapshotAccess
} from "./accessPolicy.js";
import { auditToolCall, type AuditDetails } from "./audit.js";
import { getMetabaseLoginUrl } from "./auth/loginRoutes.js";
import { getStoredMetabaseSessionStatus } from "./auth/metabaseSessions.js";
import { CatalogStore } from "./catalog.js";
import {
  ACCESS_MODE,
  getAuditConfig,
  getAuthConfig,
  getDataLimitConfig,
  getMetabaseConfig,
  getMetadataConfig,
  getMetabasePublicUrl,
  getPostHogConfig,
  getStarRocksConfig,
  getSyncFreshnessConfig
} from "./config.js";
import { runLiveAsset } from "./connectors/runAsset.js";
import { runStarRocksQuery } from "./connectors/starrocks.js";
import { assetNotFound, summarizeAsset, toLimitedTextPayload, toTextPayload } from "./format.js";
import { getRequestContext } from "./requestContext.js";
import { buildEffectiveInstructions, getGlobalInstructions, isManagedToolEnabled, listManagedTools } from "./toolStore.js";

export async function createAppDataMcpServer() {
  const catalog = CatalogStore.fromEnv();
  const limits = getDataLimitConfig();
  const [managedTools, globalInstructions] = await Promise.all([listManagedTools(), getGlobalInstructions()]);
  const enabledTools = new Set(managedTools.filter((tool) => tool.enabled).map((tool) => tool.name));
  const effectiveInstructions = buildEffectiveInstructions(globalInstructions, managedTools);

  const server = new McpServer({
    name: "app-data-mcp",
    version: "0.1.0"
  }, {
    instructions: effectiveInstructions
  });

  if (enabledTools.has("search_assets")) server.tool(
    "search_assets",
    "Search published PostgreSQL metadata for Metabase dashboards/cards, PostHog insights, metrics, tables, and events.",
    {
      query: z.string().default("").describe("Keyword query, e.g. 新增用户, activation, retention."),
      platform: z.enum(["metabase", "posthog", "local"]).optional(),
      type: z.enum(["dashboard", "card", "insight", "metric", "table", "event"]).optional(),
      domain: z.string().optional().describe("Business domain, e.g. growth, product, revenue."),
      limit: z.number().int().min(1).max(limits.maxSearchLimit).default(limits.defaultSearchLimit)
    },
    async (input) => {
      return auditToolCall("search_assets", {
        query: input.query,
        limit: input.limit,
        metadata: {
          platform: input.platform,
          type: input.type,
          domain: input.domain
        }
      }, async () => {
        const authError = requireUserToken();
        if (authError) return authError;

        const requestContext = getRequestContext();
        const requestedLimit = input.limit ?? limits.defaultSearchLimit;
        const assets = filterAssetsBySnapshotAccess(
          await catalog.search({ ...input, limit: limits.maxSearchLimit }),
          requestContext.user
        ).slice(0, requestedLimit);
        return toTextPayload({
          assets: assets.map(summarizeAsset),
          count: assets.length,
          note: "Results come from published PostgreSQL metadata and are filtered by access snapshots. Use get_asset, trace_asset, or run_asset with an id for details.",
          nextSteps: [
            "If a curated Metabase/PostHog asset answers the question, prefer run_asset.",
            "For Metabase dashboards, inspect parameters and dashboardParameterMappings to decide whether filters can answer the user's question.",
            "If no curated asset matches or custom breakdowns are needed, use semantic tools when configured."
          ]
        });
      });
    }
  );

  if (enabledTools.has("get_asset")) server.tool(
    "get_asset",
    "Get full metadata for one data asset, including source URL, query text, columns, children, and warnings.",
    {
      asset_id: z
        .string()
        .describe("Unified asset id, e.g. metabase:card:456 or posthog:insight:activation-funnel.")
    },
    async ({ asset_id }) => {
      const auditDetails: AuditDetails = { assetId: asset_id };
      return auditToolCall("get_asset", auditDetails, async () => {
        const authError = requireUserToken();
        if (authError) return authError;

        const asset = await catalog.findById(asset_id);
        if (!asset) return assetNotFound(asset_id);
        auditDetails.assetPlatform = asset.platform;
        auditDetails.assetType = asset.type;
        const accessError = await requireMetadataAccess(asset);
        if (accessError) return accessError;
        return toTextPayload({ asset });
      });
    }
  );

  if (enabledTools.has("trace_asset")) server.tool(
    "trace_asset",
    "Trace where a data asset comes from, including upstream tables/events/assets and original platform links.",
    {
      asset_id: z.string()
    },
    async ({ asset_id }) => {
      const auditDetails: AuditDetails = { assetId: asset_id };
      return auditToolCall("trace_asset", auditDetails, async () => {
        const authError = requireUserToken();
        if (authError) return authError;

        const asset = await catalog.findById(asset_id);
        if (!asset) return assetNotFound(asset_id);
        auditDetails.assetPlatform = asset.platform;
        auditDetails.assetType = asset.type;
        const accessError = await requireMetadataAccess(asset);
        if (accessError) return accessError;

        const referencedAssets = await Promise.all(
          (asset.sourceRefs ?? [])
            .map((source) => source.assetId)
            .filter((id): id is string => Boolean(id))
            .map((id) => catalog.findById(id))
        );

        return toTextPayload({
          asset: summarizeAsset(asset),
          queryText: asset.queryText,
          columns: asset.columns,
          sourceRefs: asset.sourceRefs ?? [],
          referencedAssets: filterAssetsBySnapshotAccess(
            referencedAssets.filter((ref) => ref !== undefined),
            getRequestContext().user
          ).map(summarizeAsset),
          originalUrl: asset.url,
          warnings: asset.warnings ?? []
        });
      });
    }
  );

  if (enabledTools.has("run_asset")) server.tool(
    "run_asset",
    "Return read-only live data for a supported Metabase/PostHog asset, with local sampleData fallback.",
    {
      asset_id: z.string(),
      params: z
        .record(z.unknown())
        .optional()
        .describe(
          "Optional read-only parameters. Prefer friendly names from asset.parameters, e.g. {date:'2026-07-01~2026-07-09', country:'US'}. Advanced Metabase users may pass native {parameters:[...]}."
        ),
      limit: z.number().int().min(1).max(limits.maxResultRowLimit).default(limits.defaultResultRowLimit)
    },
    async ({ asset_id, params, limit }) => {
      const auditDetails: AuditDetails = { assetId: asset_id, params, limit };
      return auditToolCall("run_asset", auditDetails, async () => {
        const authError = requireUserToken();
        if (authError) return authError;

        const asset = await catalog.findById(asset_id);
        if (!asset) return assetNotFound(asset_id);
        auditDetails.assetPlatform = asset.platform;
        auditDetails.assetType = asset.type;
        const snapshotDecision = canReadAssetMetadataFromSnapshot(asset, getRequestContext().user);
        if (!snapshotDecision.allowed) {
          return toTextPayload({
            error: "asset_access_denied",
            asset_id,
            reason: snapshotDecision.reason,
            message: "This asset is hidden by the synchronized metadata access snapshot."
          });
        }
        const paramsError = validateAssetParams(asset, params);
        if (paramsError) return paramsError;
        let liveFallbackWarning: string | undefined;

        if (asset.platform === "metabase" || asset.platform === "posthog") {
          try {
            const live = await runLiveAsset(asset, { params, limit });
            return toLimitedTextPayload({
              asset: summarizeAsset(asset),
              data: live.data,
              params: params ?? {},
              live: true,
              source: live.source,
              warnings: live.warnings
            }, limits.maxResponseBytes);
          } catch (error) {
            if (!asset.sampleData) {
              return toTextPayload({
                asset: summarizeAsset(asset),
                data: null,
                params: params ?? {},
                live: false,
                error: "live_connector_failed",
                message: error instanceof Error ? error.message : String(error),
                loginUrl: isReauthError(error) ? getMetabaseLoginUrl() : undefined,
                source: {
                  url: asset.url,
                  queryText: asset.queryText,
                  sourceRefs: asset.sourceRefs ?? []
                },
                warnings: [
                  ...(asset.warnings ?? []),
                  "No sampleData fallback is available for this asset."
                ]
              });
            }
            liveFallbackWarning = `Live connector failed; returned local sampleData instead. Reason: ${
              error instanceof Error ? error.message : String(error)
            }`;
          }
        }

        if (!asset.sampleData) {
          return toTextPayload({
            asset: summarizeAsset(asset),
            data: null,
            params: params ?? {},
            live: false,
            error: "asset_not_runnable",
            message:
              "This asset is not supported by a live connector and does not include sampleData in PostgreSQL metadata.",
            source: {
              url: asset.url,
              queryText: asset.queryText,
              sourceRefs: asset.sourceRefs ?? []
            },
            warnings: asset.warnings ?? []
          });
        }

        const rows = asset.sampleData.rows.slice(0, limit);
        const wasTruncated = asset.sampleData.rows.length > rows.length;

        return toLimitedTextPayload({
          asset: summarizeAsset(asset),
          data: {
            columns: asset.sampleData.columns,
            rows,
            rowCount: rows.length,
            totalRowsInSample: asset.sampleData.rows.length,
            limitApplied: limit,
            truncated: wasTruncated
          },
          params: params ?? {},
          live: false,
          source: {
            url: asset.url,
            queryText: asset.queryText,
            sourceRefs: asset.sourceRefs ?? []
          },
          warnings: [
            ...(asset.warnings ?? []),
            ...(liveFallbackWarning ? [liveFallbackWarning] : []),
            ...(wasTruncated ? [`Result truncated to ${limit} rows.`] : [])
          ]
        }, limits.maxResponseBytes);
      });
    }
  );

  if (enabledTools.has("query_starrocks")) server.tool(
    "query_starrocks",
    "Execute one read-only SQL query against StarRocks. Use SHOW/DESCRIBE to inspect unfamiliar schemas, then SELECT/WITH for data. DDL, DML, multi-statement SQL, file reads, and long-running helper functions are rejected. Prefer curated run_asset results when available.",
    {
      sql: z
        .string()
        .min(1)
        .max(getStarRocksConfig().maxSqlLength)
        .describe("One StarRocks read-only SQL statement: SELECT, WITH...SELECT, SHOW, DESCRIBE/DESC, or EXPLAIN."),
      limit: z.number().int().min(1).max(limits.maxResultRowLimit).default(limits.defaultResultRowLimit)
    },
    async ({ sql, limit }) => {
      const auditDetails: AuditDetails = {
        query: sql,
        limit,
        assetPlatform: "starrocks",
        assetType: "adhoc_sql",
        metadata: { database: getStarRocksConfig().database }
      };
      return auditToolCall("query_starrocks", auditDetails, async () => {
        if (!await isManagedToolEnabled("query_starrocks")) {
          return toTextPayload({
            error: "tool_not_enabled",
            tool: "query_starrocks",
            message: "SQL 查询工具 query_starrocks 未开放，当前无法通过此 MCP 直接查询 StarRocks 表数据。请联系 MCP 管理员开放该工具，或改用已开放的 Metabase/PostHog 数据资产。"
          });
        }
        const authError = requireUserToken();
        if (authError) return authError;

        try {
          const data = await runStarRocksQuery(sql, limit);
          return toLimitedTextPayload({
            data,
            source: {
              platform: "starrocks",
              database: data.database
            },
            warnings: data.truncated ? [`Result truncated to ${limit} rows.`] : []
          }, limits.maxResponseBytes);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const errorCode = message.includes(":") ? message.slice(0, message.indexOf(":")) : "starrocks_query_failed";
          return toTextPayload({
            error: errorCode,
            message,
            source: {
              platform: "starrocks",
              database: getStarRocksConfig().database
            }
          });
        }
      });
    }
  );

  if (enabledTools.has("list_domains")) server.tool("list_domains", "List business domains found in published PostgreSQL metadata.", {}, async () => {
    return auditToolCall("list_domains", {}, async () => {
      const authError = requireUserToken();
      if (authError) return authError;

      const requestContext = getRequestContext();
      const assetCatalog = await catalog.getCatalog();
      const domains = Array.from(
        new Set(
          filterAssetsBySnapshotAccess(assetCatalog.assets, requestContext.user)
            .map((asset) => asset.businessDomain)
            .filter((domain): domain is string => Boolean(domain))
        )
      ).sort();
      return toTextPayload({ domains });
    });
  });

  if (enabledTools.has("catalog_status")) server.tool(
    "catalog_status",
    "Show whether the PostgreSQL asset catalog is initialized and how many published assets it contains.",
    {},
    async () => {
      return auditToolCall("catalog_status", {}, async () => {
        const status = await catalog.status();
        const freshness = status.initialized ? await buildCatalogFreshness(catalog) : undefined;
        return toTextPayload({
          ...status,
          freshness,
          nextSteps: status.initialized
            ? status.assetCount > 0
              ? buildCatalogStatusNextSteps(freshness)
              : [
                  "The published catalog is empty.",
                  "Run a Metabase/PostHog sync, then publish assets from the /admin management page."
                ]
            : ["Check PostgreSQL DB_* configuration and database permissions."]
        });
      });
    }
  );

  if (enabledTools.has("auth_status")) server.tool(
    "auth_status",
    "Check the current MCP request user and Metabase authorization status. Call this before run_asset for Metabase assets.",
    {},
    async () => {
      return auditToolCall("auth_status", {}, async () => {
        const requestContext = getRequestContext();
        const metabaseStatus = await getStoredMetabaseSessionStatus(requestContext.user);
        const loginUrl = getMetabaseLoginUrl();

        return toTextPayload({
          user: requestContext.user,
          groups: requestContext.groups,
          authMethod: requestContext.authMethod ?? "none",
          metabase: metabaseStatus.authorized
            ? {
                authorized: true,
                user: metabaseStatus.user,
                expiresAt: metabaseStatus.expiresAt,
                sessionProvidedByHeader: Boolean(requestContext.metabaseSession),
                loginUrl
              }
            : {
                authorized: Boolean(requestContext.metabaseSession),
                reason: requestContext.metabaseSession ? "session_provided_by_header" : metabaseStatus.reason,
                configuredMcpToken: Boolean(requestContext.user),
                loginUrl,
                requiredHeaders: ["Authorization: Bearer <personal-mcp-token>"],
                message: requestContext.user
                  ? "Metabase authorization is missing or expired. Open loginUrl, complete login, then retry."
                  : "MCP client is missing a valid personal MCP token. Open loginUrl, complete login, then configure Authorization: Bearer <token>."
              },
          nextSteps: buildAuthNextSteps(requestContext.user, metabaseStatus.authorized, loginUrl)
        });
      });
    }
  );

  if (enabledTools.has("connector_status")) server.tool(
    "connector_status",
    "Show whether Metabase, PostHog, and StarRocks connector environment variables are configured. Secrets are never returned.",
    {},
    async () => {
      return auditToolCall("connector_status", {}, async () => {
        const metabase = getMetabaseConfig();
        const posthog = getPostHogConfig();
        const starrocks = getStarRocksConfig();
        const audit = getAuditConfig();
        const metadata = getMetadataConfig();
        const requestContext = getRequestContext();

        return toTextPayload({
          accessMode: ACCESS_MODE,
          requestUser: requestContext.user,
          authMethod: requestContext.authMethod ?? "none",
          requestGroups: requestContext.groups,
          metabaseUserSessionProvided: Boolean(requestContext.metabaseSession),
          metabaseLoginUrl: getMetabaseLoginUrl(),
          dataLimits: limits,
          audit: {
            enabled: audit.enabled,
            dbType: audit.dbType,
            hostConfigured: Boolean(audit.host),
            database: audit.database,
            schema: audit.schema,
            table: audit.table,
            ssl: audit.ssl,
            sslCertificateVerification: audit.ssl && audit.sslRejectUnauthorized,
            sslCaFileConfigured: Boolean(audit.sslCaFile)
          },
          metadata: {
            dbType: metadata.dbType,
            hostConfigured: Boolean(metadata.host),
            database: metadata.database,
            schema: metadata.schema,
            table: metadata.table,
            defaultPublished: metadata.defaultPublished
          },
          allowedOperations: ["search", "read_metadata", "trace_source", "run_readonly_query"],
          deniedOperations: ["create", "update", "delete", "write_back", "save_dashboard", "save_card"],
          metabase:
            metabase.mode === "missing"
              ? {
                  configured: false,
                  authMode: "missing",
                  baseUrlConfigured: Boolean(metabase.baseUrl),
                  publicUrlConfigured: Boolean(getMetabasePublicUrl()),
                  missing: metabase.missing
                }
              : {
                  configured: true,
                  authMode: metabase.mode,
                  baseUrl: metabase.baseUrl,
                  publicUrl: getMetabasePublicUrl() ?? metabase.baseUrl
                },
          posthog: {
            configured: Boolean(posthog.baseUrl && posthog.projectId && posthog.personalApiKey),
            baseUrlConfigured: Boolean(posthog.baseUrl),
            projectIdConfigured: Boolean(posthog.projectId),
            personalApiKeyConfigured: Boolean(posthog.personalApiKey)
          },
          starrocks: {
            configured: starrocks.configured,
            toolEnabled: enabledTools.has("query_starrocks"),
            availability: !enabledTools.has("query_starrocks")
              ? "tool_disabled"
              : starrocks.configured
                ? "available"
                : "connector_not_configured",
            hostConfigured: Boolean(starrocks.host),
            port: starrocks.port,
            userConfigured: Boolean(starrocks.user),
            database: starrocks.database,
            ssl: starrocks.ssl,
            queryTimeoutMs: starrocks.queryTimeoutMs,
            missing: starrocks.missing
          },
          toolAvailability: {
            enabled: managedTools.filter((tool) => tool.enabled).map((tool) => tool.name),
            disabled: managedTools.filter((tool) => !tool.enabled).map((tool) => ({
              name: tool.name,
              title: tool.title,
              reason: "disabled_by_administrator"
            }))
          }
        });
      });
    }
  );

  return server;
}

function buildAuthNextSteps(user: string | undefined, authorized: boolean, loginUrl: string): string[] {
  if (authorized) return [];
  if (!user) {
    return [
      `Open ${loginUrl} and log in with your Metabase account.`,
      "Copy the personal MCP token shown after login.",
      "Configure your MCP client to send Authorization: Bearer <personal-mcp-token>.",
      "Retry the data request after authorization."
    ];
  }
  return [
    `Open ${loginUrl} and log in as ${user}.`,
    "Retry the data request after authorization."
  ];
}

function isReauthError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("reauth_required");
}

function requireUserToken() {
  const authConfig = getAuthConfig();
  const requestContext = getRequestContext();
  if (!authConfig.requireUserHeader || requestContext.user) return null;

  const loginUrl = getMetabaseLoginUrl();
  return toTextPayload({
    error: "auth_required",
    message:
      "This data tool requires a valid personal MCP token. Configure your MCP client to send Authorization: Bearer <token> before using app-data tools.",
    requiredHeaders: ["Authorization: Bearer <personal-mcp-token>"],
    loginUrl,
    nextSteps: [
      `Open ${loginUrl} and log in with your Metabase account.`,
      "Copy the personal MCP token shown after successful authorization.",
      "Re-add or update the MCP client with Authorization: Bearer <personal-mcp-token>.",
      "Retry the request after the token is configured."
    ]
  });
}

async function requireMetadataAccess(asset: import("./types.js").DataAsset) {
  const requestContext = getRequestContext();
  const snapshotDecision = canReadAssetMetadataFromSnapshot(asset, requestContext.user);
  if (!snapshotDecision.allowed) {
    return toTextPayload({
      error: "metadata_access_denied",
      asset_id: asset.id,
      reason: snapshotDecision.reason,
      message: "This asset is hidden by the synchronized metadata access snapshot."
    });
  }

  const liveDecision = await canReadAssetMetadataLive(asset);
  if (!liveDecision.allowed) {
    return toTextPayload({
      error: "metadata_access_denied",
      asset_id: asset.id,
      reason: liveDecision.reason,
      loginUrl: getMetabaseLoginUrl(),
      message:
        liveDecision.reason === "metabase_session_missing"
          ? "Metabase authorization is required before returning this asset's metadata."
          : "Metabase did not allow the current user to read this asset metadata."
    });
  }

  return null;
}

function validateAssetParams(asset: import("./types.js").DataAsset, params: Record<string, unknown> | undefined) {
  if (!params || Array.isArray(params.parameters)) return null;
  if (!asset.parameters?.length) return null;

  const allowed = new Set(asset.parameters.map((parameter) => parameter.name));
  const unknown = Object.keys(params).filter((key) => !allowed.has(key));
  if (!unknown.length) return null;

  return toTextPayload({
    error: "unsupported_asset_parameters",
    asset_id: asset.id,
    unknown,
    supportedParameters: asset.parameters.map((parameter) => ({
      name: parameter.name,
      type: parameter.type,
      label: parameter.label,
      description: parameter.description
    })),
    message:
      "This asset only accepts declared friendly parameters. Use supported parameter names, or use platform-native params.parameters when needed."
  });
}

async function buildCatalogFreshness(catalog: CatalogStore) {
  const assetCatalog = await catalog.getCatalog();
  const syncConfig = getSyncFreshnessConfig();
  const metabaseAssets = assetCatalog.assets.filter((asset) => asset.platform === "metabase");
  const posthogAssets = assetCatalog.assets.filter((asset) => asset.platform === "posthog");
  const catalogUpdatedAt = assetCatalog.updatedAt;

  return {
    metabase: buildPlatformFreshness(
      metabaseAssets.map((asset) => asset.access?.syncedAt ?? catalogUpdatedAt).filter(Boolean) as string[],
      syncConfig.metabaseMetadataSyncIntervalHours
    ),
    metabasePermissionSnapshots: buildPlatformFreshness(
      metabaseAssets.map((asset) => asset.access?.syncedAt).filter(Boolean) as string[],
      syncConfig.metabasePermissionSyncIntervalHours
    ),
    posthog: buildPlatformFreshness(
      posthogAssets.map((asset) => asset.access?.syncedAt ?? catalogUpdatedAt).filter(Boolean) as string[],
      syncConfig.posthogMetadataSyncIntervalHours
    )
  };
}

function buildPlatformFreshness(syncedAtValues: string[], intervalHours: number) {
  const timestamps = syncedAtValues
    .map((value) => new Date(value).getTime())
    .filter((value) => Number.isFinite(value));
  const latest = timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : undefined;
  const ageHours = latest ? (Date.now() - new Date(latest).getTime()) / (60 * 60 * 1000) : undefined;
  return {
    latestSyncedAt: latest,
    expectedIntervalHours: intervalHours,
    ageHours: ageHours === undefined ? undefined : Number(ageHours.toFixed(2)),
    stale: ageHours === undefined ? true : ageHours > intervalHours
  };
}

function buildCatalogStatusNextSteps(freshness: Awaited<ReturnType<typeof buildCatalogFreshness>> | undefined): string[] {
  if (!freshness) return [];
  const steps = [];
  if (freshness.metabase.stale || freshness.metabasePermissionSnapshots.stale) {
    steps.push('Run "npm run sync:metabase" to refresh Metabase metadata and access snapshots.');
  }
  if (freshness.posthog.stale) {
    steps.push('Run "npm run sync:posthog" to refresh PostHog metadata.');
  }
  return steps;
}
