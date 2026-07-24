import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  canReadAssetMetadataFromSnapshot,
  canReadAssetMetadataLive,
  filterAssetsByLiveAccess,
  filterAssetsBySnapshotAccess
} from "./accessPolicy.js";
import { auditToolCall, type AuditDetails } from "./audit.js";
import {
  buildAssetSelectionSummary,
  evaluateModelAggregationSelection,
  rankAssetsForQuestion,
  summarizeSelectionRank
} from "./assetSelectionGovernance.js";
import { getMetabaseLoginUrl } from "./auth/loginRoutes.js";
import { getStoredMetabaseSessionStatus } from "./auth/metabaseSessions.js";
import { CatalogStore, type ResolvedAsset, summarizeCatalogAssets } from "./catalog.js";
import {
  ACCESS_MODE,
  getAudienceExportConfig,
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
import { createAudienceExport } from "./audienceExports.js";
import { runLiveAsset } from "./connectors/runAsset.js";
import { runMetabaseAudience, runMetabaseAudienceCsv } from "./connectors/metabase.js";
import { runStarRocksQuery } from "./connectors/starrocks.js";
import { assetNotFound, summarizeAsset, summarizeSemanticMatches, toLimitedTextPayload, toTextPayload } from "./format.js";
import { getRequestContext } from "./requestContext.js";
import { evaluateSqlGovernance } from "./queryGovernance.js";
import {
  buildEffectiveInstructions,
  getAvailableToolNames,
  getGlobalInstructions,
  listManagedTools
} from "./toolStore.js";

export async function createAppDataMcpServer(options: { user?: string } = {}) {
  const catalog = CatalogStore.fromEnv();
  const limits = getDataLimitConfig();
  const [managedTools, globalInstructions, enabledTools] = await Promise.all([
    listManagedTools(),
    getGlobalInstructions(),
    getAvailableToolNames(options.user)
  ]);
  const effectiveInstructions = buildEffectiveInstructions(globalInstructions, managedTools, enabledTools);

  const server = new McpServer({
    name: "app-data-mcp",
    version: "0.1.0"
  }, {
    instructions: effectiveInstructions
  });

  if (enabledTools.has("search_assets")) server.tool(
    "search_assets",
    "MANDATORY FIRST STEP for ordinary data questions. Search published governed assets using the user's original question. Cards rank ahead of Models for metric, trend, and breakdown analysis.",
    {
      query: z.string().default("").describe("Keyword query, e.g. 新增用户, activation, retention."),
      platform: z.enum(["metabase", "posthog", "local"]).optional(),
      type: z.enum(["dashboard", "card", "model", "insight", "metric", "table", "event"]).optional(),
      domain: z.string().optional().describe("Business domain, e.g. growth, product, revenue."),
      limit: z.number().int().min(1).max(limits.maxSearchLimit).default(limits.defaultSearchLimit)
    },
    async (input) => {
      return auditToolCall("search_assets", {
        query: input.query,
        question: input.query,
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
        const snapshotVisibleAssets = filterAssetsBySnapshotAccess(
          await catalog.search({ ...input, limit: limits.maxSearchLimit }),
          requestContext.user
        );
        const routing = rankAssetsForQuestion(
          await filterAssetsByLiveAccess(snapshotVisibleAssets),
          input.query
        );
        const assets = routing.assets.slice(0, requestedLimit);
        const selection = buildAssetSelectionSummary(assets, routing.intent);
        return toTextPayload({
          assets: assets.map((asset, index) => ({
            ...summarizeAsset(asset),
            matchedSemanticItems: summarizeSemanticMatches(asset, input.query),
            selection: summarizeSelectionRank(
              asset,
              index + 1,
              selection.recommendedAssetId,
              routing.assessments.get(asset.id)
            )
          })),
          count: assets.length,
          selection,
          note: "Results come from published PostgreSQL metadata and are filtered by synchronized snapshots plus the current user's live Metabase permissions. Use get_asset, trace_asset, or run_asset with an id for details.",
          nextSteps: [
            "Follow selection.candidateOrder, but call get_asset before execution to verify the recommended asset's dimensions, parameters, formula, and field semantics.",
            "Prefer execution.mode=precomputed/cached metric-set Cards, then governed Metrics, then live-query Cards. Always call get_asset before execution.",
            "Do not use Model aggregations to recreate a result already available from a Metric or Card. Model defaults to detail-only; guarded aggregation requires declared fields, the original question, rejected_asset_ids, and a concrete fallback_reason.",
            "Treat semantic.role=metric_set Cards as governed multi-measure assets: inspect measures, formula, execution, defaultTimeDimension, dimensions, and rollup rules, then use semantic.measures/filters/breakouts.",
            "Treat an ordinary Card as a direct answer mainly for saved-report intent or when its parameters and output columns clearly cover the question.",
            "For Metabase dashboards, inspect parameters and dashboardParameterMappings to decide whether filters can answer the user's question.",
            ...(enabledTools.has("query_starrocks")
              ? ["Do not call query_starrocks while a suitable candidate exists. SQL fallback requires rejecting returned candidate IDs with a concrete reason."]
              : [])
          ]
        });
      });
    }
  );

  if (enabledTools.has("get_asset")) server.tool(
    "get_asset",
    "Get full metadata for one published data asset, or for an unpublished Metabase Card inherited from an accessible published Dashboard. Includes source URL, query text, columns, children, and warnings.",
    {
      asset_id: z
        .string()
        .describe("Unified asset id, e.g. metabase:card:456, metabase:model:388, metabase:metric:480, or posthog:insight:activation-funnel.")
    },
    async ({ asset_id }) => {
      const auditDetails: AuditDetails = { assetId: asset_id };
      return auditToolCall("get_asset", auditDetails, async () => {
        const authError = requireUserToken();
        if (authError) return authError;

        const resolved = await catalog.resolveById(asset_id);
        if (!resolved) return assetNotFound(asset_id);
        const { asset } = resolved;
        auditDetails.assetPlatform = asset.platform;
        auditDetails.assetType = asset.type;
        const accessError = await requireResolvedAssetAccess(resolved);
        if (accessError) return accessError;
        return toTextPayload({
          asset,
          access: describeResolvedAssetAccess(resolved)
        });
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

        const resolved = await catalog.resolveById(asset_id);
        if (!resolved) return assetNotFound(asset_id);
        const { asset } = resolved;
        auditDetails.assetPlatform = asset.platform;
        auditDetails.assetType = asset.type;
        const accessError = await requireResolvedAssetAccess(resolved);
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
          metric: asset.metric,
          sourceRefs: asset.sourceRefs ?? [],
          referencedAssets: filterAssetsBySnapshotAccess(
            referencedAssets.filter((ref) => ref !== undefined),
            getRequestContext().user
          ).map(summarizeAsset),
          originalUrl: asset.url,
          access: describeResolvedAssetAccess(resolved),
          warnings: asset.warnings ?? []
        });
      });
    }
  );

  if (enabledTools.has("run_asset")) server.tool(
    "run_asset",
    "Return read-only live data for a supported asset. Precomputed/cached metric-set Cards are preferred, followed by Metrics and live Cards. Models default to detail-only; guarded aggregation requires declared fields and fallback evidence.",
    {
      asset_id: z.string(),
      question: z.string().min(1).optional().describe(
        "The user's original data question. Required when semantic.aggregations is used on a Model so the server can enforce Metric-and-Card-first selection."
      ),
      rejected_asset_ids: z.array(z.string().min(1)).max(50).optional().describe(
        "Matching higher-priority Metric or Card IDs already inspected and found unsuitable. Requires fallback_reason."
      ),
      fallback_reason: z.string().min(1).max(1000).optional().describe(
        "Concrete reason the rejected Metric or Card candidates cannot answer the question."
      ),
      params: z
        .record(z.unknown())
        .optional()
        .describe(
          "Optional read-only parameters. Prefer friendly names from asset.parameters, e.g. {date:'2026-07-01~2026-07-09', country:'US'}. Advanced Metabase users may pass native {parameters:[...]}."
        ),
      semantic: z.object({
        filters: z.array(z.object({
          field: z.string().min(1),
          operator: z.enum(["eq", "neq", "gt", "gte", "lt", "lte", "in", "not_in", "contains", "is_null", "not_null", "between"]),
          value: z.unknown().optional()
        }).strict()).max(20).optional(),
        breakouts: z.array(z.object({
          field: z.string().min(1),
          unit: z.enum(["minute", "hour", "day", "week", "month", "quarter", "year"]).optional()
        }).strict()).max(5).optional(),
        fields: z.array(z.string().min(1)).max(50).optional(),
        aggregations: z.array(z.object({
          operator: z.enum(["count", "distinct", "sum", "avg", "min", "max"]),
          field: z.string().min(1).optional(),
          alias: z.string().min(1).max(100).optional()
        }).strict()).max(10).optional(),
        measures: z.array(z.string().min(1)).min(1).max(20).optional(),
        cumulative: z.array(z.object({
          measure: z.string().min(1),
          orderBy: z.string().min(1),
          partitionBy: z.array(z.string().min(1)).max(10).optional(),
          alias: z.string().min(1).max(100).optional()
        }).strict()).max(10).optional()
      }).strict().optional().describe(
        "Validated semantic controls for Metabase Model, Metric, and semantic.role=metric_set Cards. Card metric sets enforce rollup and recompute formulas such as sum(B)/sum(C). Metric preserves its formula. Model always allows governed detail fields, but aggregations require modelSemantic.aggregationPolicy=guarded and declared baseGrain/entityFields/additiveFields."
      ),
      limit: z.number().int().min(1).max(limits.maxResultRowLimit).default(limits.defaultResultRowLimit)
    },
    async ({ asset_id, question, rejected_asset_ids, fallback_reason, params, semantic, limit }) => {
      const auditDetails: AuditDetails = {
        assetId: asset_id,
        query: question,
        question,
        params,
        limit,
        metadata: {
          ...(semantic ? { semantic } : {}),
          ...(rejected_asset_ids?.length ? { rejectedAssetIds: rejected_asset_ids } : {}),
          ...(fallback_reason ? { fallbackReason: fallback_reason } : {})
        }
      };
      return auditToolCall("run_asset", auditDetails, async () => {
        const authError = requireUserToken();
        if (authError) return authError;

        const resolved = await catalog.resolveById(asset_id);
        if (!resolved) return assetNotFound(asset_id);
        const { asset } = resolved;
        auditDetails.assetPlatform = asset.platform;
        auditDetails.assetType = asset.type;
        const accessError = await requireResolvedAssetRunAccess(resolved);
        if (accessError) return accessError;
        const higherPriorityCandidates = question?.trim()
          ? (await filterAssetsByLiveAccess(filterAssetsBySnapshotAccess(
              await catalog.search({ query: question, platform: asset.platform, limit: limits.maxSearchLimit }),
              getRequestContext().user
            ))).filter((candidate) => candidate.type === "metric" || candidate.type === "card")
          : [];
        const selectionDecision = evaluateModelAggregationSelection(asset, higherPriorityCandidates, {
          question,
          rejectedAssetIds: rejected_asset_ids,
          fallbackReason: fallback_reason,
          hasAggregations: Boolean(semantic?.aggregations?.length)
        });
        if (!selectionDecision.allowed) {
          return toTextPayload({
            error: selectionDecision.code,
            message: selectionDecision.message,
            attempted_asset: summarizeAsset(asset),
            higher_priority_candidates: selectionDecision.candidates.map(summarizeAsset),
            required_action: selectionDecision.code === "asset_question_required"
              ? "Retry run_asset with the user's original question."
              : "Inspect each Metric and Card with get_asset and run a suitable asset. To fall back, retry with all unsuitable candidate IDs in rejected_asset_ids and provide fallback_reason."
          });
        }
        const paramsError = validateAssetParams(asset, params);
        if (paramsError) return paramsError;
        let liveFallbackWarning: string | undefined;

        if (asset.platform === "metabase" || asset.platform === "posthog") {
          try {
            const live = await runLiveAsset(asset, { params, semantic, limit });
            return toLimitedTextPayload({
              asset: summarizeAsset(asset),
              access: describeResolvedAssetAccess(resolved),
              data: live.data,
              params: params ?? {},
              semantic: semantic ?? undefined,
              live: true,
              source: live.source,
              warnings: live.warnings
            }, limits.maxResponseBytes);
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            if (asset.platform === "metabase" && isReauthError(error)) {
              return toTextPayload({
                asset: summarizeAsset(asset),
                access: describeResolvedAssetAccess(resolved),
                data: null,
                params: params ?? {},
                live: false,
                error: "reauth_required",
                message: "Metabase rejected the Session associated with this personal MCP token. Reauthorize this Metabase account, then replace the MCP client configuration with the newly issued personal token; the previous token will be invalidated.",
                loginUrl: getMetabaseLoginUrl(),
                source: {
                  url: asset.url,
                  queryText: asset.queryText,
                  sourceRefs: asset.sourceRefs ?? []
                }
              });
            }
            if (errorMessage.startsWith("semantic_")) {
              return toTextPayload({
                asset: summarizeAsset(asset),
                access: describeResolvedAssetAccess(resolved),
                data: null,
                params: params ?? {},
                semantic: semantic ?? undefined,
                live: false,
                error: "semantic_query_invalid",
                message: errorMessage,
                guidance: "Call get_asset and use exact field or measure names. For metric_set Cards, inspect semantic.measures, dimensions, defaultTimeDimension, and rollup rules. Metric formulas are immutable."
              });
            }
            if (!asset.sampleData) {
              return toTextPayload({
                asset: summarizeAsset(asset),
                access: describeResolvedAssetAccess(resolved),
                data: null,
                params: params ?? {},
                live: false,
                error: "live_connector_failed",
                message: errorMessage,
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
            access: describeResolvedAssetAccess(resolved),
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
          access: describeResolvedAssetAccess(resolved),
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

  if (enabledTools.has("query_audience")) server.tool(
    "query_audience",
    "Compose 2-10 audience-enabled Metabase Models by their governed uid field. Supports intersection, union, and first-model-minus-rest difference. The complete set operation runs inside Metabase with the current user's Session; IDs are never combined client-side.",
    {
      operator: z.enum(["intersection", "union", "difference"]).default("intersection"),
      models: z.array(z.object({
        asset_id: z.string().min(1),
        filters: z.array(z.object({
          field: z.string().min(1),
          operator: z.enum(["eq", "neq", "gt", "gte", "lt", "lte", "in", "not_in", "contains", "is_null", "not_null", "between"]),
          value: z.unknown().optional()
        }).strict()).max(20).optional()
      }).strict()).min(2).max(10),
      output: z.enum(["count", "uids"]).default("count"),
      limit: z.number().int().min(1).max(limits.maxResultRowLimit).default(limits.defaultResultRowLimit)
    },
    async ({ operator, models, output, limit }) => {
      const assetIds = models.map((model) => model.asset_id);
      const auditDetails: AuditDetails = {
        assetId: assetIds.join(","),
        assetPlatform: "metabase",
        assetType: "audience",
        params: models,
        limit: output === "count" ? 1 : limit,
        metadata: { operator, output, assetIds }
      };
      return auditToolCall("query_audience", auditDetails, async () => {
        const authError = requireUserToken();
        if (authError) return authError;

        const assets = await Promise.all(assetIds.map((assetId) => catalog.findById(assetId)));
        const missing = assetIds.filter((_, index) => !assets[index]);
        if (missing.length) {
          return toTextPayload({
            error: "asset_not_found",
            asset_ids: missing,
            message: `No data assets found for: ${missing.join(", ")}`
          });
        }

        for (const asset of assets) {
          const accessError = await requireMetadataAccess(asset!);
          if (accessError) return accessError;
        }

        try {
          const data = await runMetabaseAudience(
            models.map((model, index) => ({ asset: assets[index]!, filters: model.filters })),
            { operator, output, limit }
          );
          return toLimitedTextPayload({
            audience: {
              entityType: "user",
              identityField: "uid",
              operator,
              output,
              models: assets.map((asset) => summarizeAsset(asset!))
            },
            data,
            warnings: [
              "Audience membership was computed inside Metabase using the current user's permissions.",
              ...(output === "uids" && data.truncated ? [`UID output truncated to ${limit} rows.`] : [])
            ]
          }, limits.maxResponseBytes);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return toTextPayload({
            error: isReauthError(error)
              ? "reauth_required"
              : message.includes(":") ? message.slice(0, message.indexOf(":")) : "audience_query_failed",
            message,
            asset_ids: assetIds,
            loginUrl: isReauthError(error) ? getMetabaseLoginUrl() : undefined
          });
        }
      });
    }
  );

  if (enabledTools.has("export_audience")) server.tool(
    "export_audience",
    "Export the complete governed UID result for 2-10 audience-enabled Metabase Models to a temporary CSV. The set operation runs inside Metabase with the current user's permissions; the CSV is stored server-side and returned as an expiring download URL. Fails instead of silently truncating when the configured row or byte limit is exceeded.",
    {
      operator: z.enum(["intersection", "union", "difference"]).default("intersection"),
      models: z.array(z.object({
        asset_id: z.string().min(1),
        filters: z.array(z.object({
          field: z.string().min(1),
          operator: z.enum(["eq", "neq", "gt", "gte", "lt", "lte", "in", "not_in", "contains", "is_null", "not_null", "between"]),
          value: z.unknown().optional()
        }).strict()).max(20).optional()
      }).strict()).min(2).max(10),
      filename: z.string().min(1).max(100).optional(),
      max_rows: z.number().int().min(1).max(getAudienceExportConfig().maxRows).default(getAudienceExportConfig().maxRows)
    },
    async ({ operator, models, filename, max_rows }) => {
      const assetIds = models.map((model) => model.asset_id);
      const auditDetails: AuditDetails = {
        assetId: assetIds.join(","),
        assetPlatform: "metabase",
        assetType: "audience_export",
        params: models,
        limit: max_rows,
        metadata: { operator, assetIds, filename }
      };
      return auditToolCall("export_audience", auditDetails, async () => {
        const authError = requireUserToken();
        if (authError) return authError;

        const assets = await Promise.all(assetIds.map((assetId) => catalog.findById(assetId)));
        const missing = assetIds.filter((_, index) => !assets[index]);
        if (missing.length) {
          return toTextPayload({
            error: "asset_not_found",
            asset_ids: missing,
            message: `No data assets found for: ${missing.join(", ")}`
          });
        }
        for (const asset of assets) {
          const accessError = await requireMetadataAccess(asset!);
          if (accessError) return accessError;
        }

        try {
          const data = await runMetabaseAudienceCsv(
            models.map((model, index) => ({ asset: assets[index]!, filters: model.filters })),
            { operator, limit: max_rows }
          );
          if (data.truncated) {
            return toTextPayload({
              error: "audience_export_too_many_rows",
              message: `Audience exceeds the export limit of ${max_rows} UID rows. Add filters or raise AUDIENCE_EXPORT_MAX_ROWS within the server's safe capacity.`,
              maxRows: max_rows,
              exported: false
            });
          }
          const result = await createAudienceExport(data.uids, {
            user: getRequestContext().user,
            filename
          });
          return toTextPayload({
            count: result.rowCount,
            export: {
              format: "csv",
              filename: result.downloadName,
              rowCount: result.rowCount,
              bytes: result.bytes,
              sha256: result.sha256,
              createdAt: result.createdAt,
              expiresAt: result.expiresAt,
              downloadUrl: result.downloadUrl,
              localPath: result.localPath
            },
            audience: {
              entityType: "user",
              identityField: "uid",
              operator,
              assetIds
            },
            warnings: [
              "The download URL is a temporary bearer capability. Do not share it with unauthorized users.",
              "The export contains complete user-level identifiers and is automatically deleted after expiry."
            ]
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return toTextPayload({
            error: isReauthError(error)
              ? "reauth_required"
              : message.includes(":") ? message.slice(0, message.indexOf(":")) : "audience_export_failed",
            message,
            asset_ids: assetIds,
            exported: false,
            loginUrl: isReauthError(error) ? getMetabaseLoginUrl() : undefined
          });
        }
      });
    }
  );

  if (enabledTools.has("query_starrocks")) server.tool(
    "query_starrocks",
    "Fallback-only StarRocks SQL. The original data question is required and the server searches published governed assets before executing. If Metric/Model/Card candidates exist, SQL is blocked until they are inspected and explicitly rejected with a reason. Use purpose=user_requested_sql only when the user explicitly asks for SQL.",
    {
      question: z.string().min(2).max(1000).describe("The user's original natural-language data question. Required for server-side governed asset discovery."),
      sql: z
        .string()
        .min(1)
        .max(getStarRocksConfig().maxSqlLength)
        .describe("One StarRocks read-only SQL statement: SELECT, WITH...SELECT, SHOW, DESCRIBE/DESC, or EXPLAIN."),
      purpose: z.enum(["data_question", "metadata_inspection", "user_requested_sql"])
        .default("data_question")
        .describe("Use data_question normally; metadata_inspection only for SHOW/DESCRIBE/EXPLAIN; user_requested_sql only when the user explicitly requested direct SQL."),
      rejected_asset_ids: z.array(z.string()).max(20).optional().describe("Governed asset IDs previously returned by this tool that were inspected and found unsuitable."),
      fallback_reason: z.string().min(5).max(1000).optional().describe("Required when rejected_asset_ids is non-empty; explain why those assets cannot answer the question."),
      limit: z.number().int().min(1).max(limits.maxResultRowLimit).default(limits.defaultResultRowLimit)
    },
    async ({ question, sql, purpose, rejected_asset_ids, fallback_reason, limit }) => {
      const auditDetails: AuditDetails = {
        query: sql,
        question,
        limit,
        assetPlatform: "starrocks",
        assetType: "adhoc_sql",
        metadata: {
          database: getStarRocksConfig().database,
          question,
          purpose,
          rejectedAssetIds: rejected_asset_ids,
          fallbackReason: fallback_reason
        }
      };
      return auditToolCall("query_starrocks", auditDetails, async () => {
        const authError = requireUserToken();
        if (authError) return authError;

        const candidates = purpose === "data_question"
          ? filterAssetsBySnapshotAccess(
              await catalog.search({ query: question, limit: Math.min(limits.maxSearchLimit, 20) }),
              getRequestContext().user
            ).filter((asset) => ["metric", "model", "card", "dashboard", "insight"].includes(asset.type))
          : [];
        const governance = evaluateSqlGovernance(candidates, {
          sql,
          purpose,
          rejectedAssetIds: rejected_asset_ids,
          fallbackReason: fallback_reason
        });
        if (!governance.allowed) {
          return toTextPayload({
            error: governance.code,
            message: governance.message,
            question,
            candidates: governance.candidates.map(summarizeAsset),
            requiredNextStep: governance.code === "governed_assets_available"
              ? "Call get_asset for the best candidate, then run_asset. If every candidate is unsuitable, call query_starrocks again with their IDs in rejected_asset_ids and a concrete fallback_reason."
              : "Correct the query_starrocks governance arguments before retrying.",
            sqlExecuted: false
          });
        }

        try {
          const data = await runStarRocksQuery(sql, limit);
          return toLimitedTextPayload({
            data,
            source: {
              platform: "starrocks",
              database: data.database
            },
            governance: {
              purpose,
              question,
              checkedCandidateCount: candidates.length,
              rejectedAssetIds: rejected_asset_ids ?? [],
              fallbackReason: fallback_reason
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
      const visibleAssets = await filterAssetsByLiveAccess(
        filterAssetsBySnapshotAccess(assetCatalog.assets, requestContext.user)
      );
      const domains = Array.from(
        new Set(
          visibleAssets
            .map((asset) => asset.businessDomain)
            .filter((domain): domain is string => Boolean(domain))
        )
      ).sort();
      return toTextPayload({ domains });
    });
  });

  if (enabledTools.has("catalog_status")) server.tool(
    "catalog_status",
    "Show catalog freshness and asset counts visible to the current MCP user. Metabase counts are filtered with the user's live permissions.",
    {},
    async () => {
      return auditToolCall("catalog_status", {}, async () => {
        const authError = requireUserToken();
        if (authError) return authError;

        const status = await catalog.status();
        if (!status.initialized) {
          return toTextPayload({
            ...status,
            scope: "current_user",
            nextSteps: ["Check PostgreSQL DB_* configuration and database permissions."]
          });
        }

        const requestContext = getRequestContext();
        const assetCatalog = await catalog.getCatalog();
        const snapshotVisibleAssets = filterAssetsBySnapshotAccess(
          assetCatalog.assets,
          requestContext.user
        );
        const visibleAssets = await filterAssetsByLiveAccess(snapshotVisibleAssets);
        const visibleSummary = summarizeCatalogAssets(visibleAssets);
        const freshness = await buildCatalogFreshness(catalog, assetCatalog);

        return toTextPayload({
          ...status,
          ...visibleSummary,
          scope: "current_user",
          user: requestContext.user,
          freshness,
          note: "Counts include only assets visible to the current MCP user. Metabase assets are filtered by synchronized snapshots and the user's live Metabase permissions.",
          nextSteps: visibleSummary.assetCount > 0
            ? buildCatalogStatusNextSteps(freshness)
            : [
                "No published assets are visible to the current user.",
                "Check the user's Metabase permissions or publish suitable assets from the /admin management page."
              ]
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
                localExpiryEnforced: false,
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
    enabledTools.has("query_starrocks")
      ? "Show whether Metabase, PostHog, and StarRocks connector environment variables are configured. Secrets are never returned."
      : "Show whether Metabase and PostHog connector environment variables are configured. Secrets are never returned.",
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
          ...(enabledTools.has("query_starrocks")
            ? {
                starrocks: {
                  configured: starrocks.configured,
                  availability: starrocks.configured ? "available" : "connector_not_configured",
                  hostConfigured: Boolean(starrocks.host),
                  port: starrocks.port,
                  userConfigured: Boolean(starrocks.user),
                  database: starrocks.database,
                  ssl: starrocks.ssl,
                  queryTimeoutMs: starrocks.queryTimeoutMs,
                  missing: starrocks.missing
                }
              }
            : {})
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
    "Copy the newly issued personal MCP token; reauthorization invalidates the previous token.",
    "Replace the MCP client's Authorization bearer token with the new token.",
    "Retry the data request after updating the client configuration."
  ];
}

function isReauthError(error: unknown): boolean {
  return error instanceof Error && (
    error.message.includes("reauth_required") ||
    error.message.includes("HTTP 401")
  );
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

async function requireResolvedAssetAccess(resolved: ResolvedAsset) {
  if (!resolved.inheritedFromDashboards.length) {
    return requireMetadataAccess(resolved.asset);
  }

  const requestContext = getRequestContext();
  const deniedReasons: string[] = [];
  for (const dashboard of resolved.inheritedFromDashboards) {
    const snapshotDecision = canReadAssetMetadataFromSnapshot(dashboard, requestContext.user);
    if (!snapshotDecision.allowed) {
      deniedReasons.push(`${dashboard.id}:${snapshotDecision.reason ?? "snapshot_denied"}`);
      continue;
    }
    const liveDecision = await canReadAssetMetadataLive(dashboard);
    if (liveDecision.allowed) return null;
    deniedReasons.push(`${dashboard.id}:${liveDecision.reason ?? "live_denied"}`);
  }

  return toTextPayload({
    error: "metadata_access_denied",
    asset_id: resolved.asset.id,
    reason: "no_accessible_published_parent_dashboard",
    parent_dashboard_checks: deniedReasons,
    loginUrl: getMetabaseLoginUrl(),
    message: "This Card is inherited from a published Dashboard, but Metabase did not allow the current user to read any parent Dashboard."
  });
}

async function requireResolvedAssetRunAccess(resolved: ResolvedAsset) {
  if (resolved.inheritedFromDashboards.length) {
    return requireResolvedAssetAccess(resolved);
  }

  const snapshotDecision = canReadAssetMetadataFromSnapshot(
    resolved.asset,
    getRequestContext().user
  );
  if (snapshotDecision.allowed) return null;
  return toTextPayload({
    error: "asset_access_denied",
    asset_id: resolved.asset.id,
    reason: snapshotDecision.reason,
    message: "This asset is hidden by the synchronized metadata access snapshot."
  });
}

function describeResolvedAssetAccess(resolved: ResolvedAsset) {
  if (!resolved.inheritedFromDashboards.length) {
    return { mode: "published" as const };
  }
  return {
    mode: "dashboard_inherited" as const,
    dashboards: resolved.inheritedFromDashboards.map(summarizeAsset)
  };
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

async function buildCatalogFreshness(
  catalog: CatalogStore,
  loadedCatalog?: Awaited<ReturnType<CatalogStore["getCatalog"]>>
) {
  const assetCatalog = loadedCatalog ?? await catalog.getCatalog();
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
