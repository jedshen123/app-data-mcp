import { getPostHogConfig } from "../config.js";
import type { ColumnMeta, DataAsset } from "../types.js";
import { fetchJson, getObject, getString, isObject, joinUrl } from "../sync/http.js";

type RunOptions = {
  params?: Record<string, unknown>;
  limit: number;
};

type NormalizedResult = {
  columns: ColumnMeta[];
  rows: Record<string, unknown>[];
  totalRowsReturned: number;
  limitApplied: number;
  truncated: boolean;
  rawShape: string;
};

export async function runPostHogAsset(asset: DataAsset, options: RunOptions) {
  if (asset.type !== "insight") {
    throw new Error(`PostHog execution is only supported for insight assets, got ${asset.type}.`);
  }

  const config = getPostHogConfig();
  if (!config.baseUrl || !config.projectId || !config.personalApiKey) {
    throw new Error("PostHog config is incomplete: POSTHOG_BASE_URL, POSTHOG_PROJECT_ID, POSTHOG_PERSONAL_API_KEY.");
  }

  const insightId = getAssetIdSuffix(asset.id);
  const insightUrl = buildPostHogInsightUrl(config.baseUrl, config.projectId, insightId, options.params);
  const insight = await fetchJson<Record<string, unknown>>(
    insightUrl,
    {
      headers: {
        authorization: `Bearer ${config.personalApiKey}`
      }
    }
  );

  const result = normalizePostHogInsight(insight, options.limit);
  return {
    data: result,
    source: {
      url: asset.url,
      queryText: asset.queryText,
      sourceRefs: asset.sourceRefs ?? []
    },
    warnings: [
      ...(asset.warnings ?? []),
      "Live data returned from PostHog using a read-only insight endpoint.",
      ...(options.params && Object.keys(options.params).length
        ? ["PostHog insight parameter overrides were sent as read-only query parameters when supported by PostHog."]
        : []),
      ...(result.truncated ? [`Result truncated to ${options.limit} rows.`] : [])
    ]
  };
}

function buildPostHogInsightUrl(
  baseUrl: string,
  projectId: string,
  insightId: string,
  params: Record<string, unknown> | undefined
): string {
  const url = new URL(joinUrl(baseUrl, `/api/projects/${projectId}/insights/${insightId}/`));
  url.searchParams.set("refresh", "blocking");

  if (!params) return url.toString();
  for (const key of ["date_from", "date_to", "breakdown"]) {
    const value = params[key];
    if (typeof value === "string" && value.trim()) url.searchParams.set(key, value);
  }
  if (Array.isArray(params.properties)) {
    url.searchParams.set("properties", JSON.stringify(params.properties));
  }

  return url.toString();
}

function normalizePostHogInsight(insight: Record<string, unknown>, limit: number): NormalizedResult {
  const result = insight.result;
  const rows = extractRows(result).slice(0, limit);
  return {
    columns: inferColumns(rows, insight),
    rows,
    totalRowsReturned: extractRows(result).length,
    limitApplied: limit,
    truncated: extractRows(result).length > rows.length,
    rawShape: Array.isArray(result) ? "array_result" : isObject(result) ? "object_result" : "scalar_result"
  };
}

function extractRows(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.map((item, index) => normalizeRow(item, index));
  }

  if (isObject(value)) {
    const nested = value.results ?? value.result ?? value.data;
    if (Array.isArray(nested)) return nested.map((item, index) => normalizeRow(item, index));
    return [value];
  }

  return [{ value }];
}

function normalizeRow(value: unknown, index: number): Record<string, unknown> {
  if (isObject(value)) return value;
  if (Array.isArray(value)) {
    return value.reduce<Record<string, unknown>>((record, item, itemIndex) => {
      record[`value_${itemIndex + 1}`] = item;
      return record;
    }, { index });
  }
  return { index, value };
}

function inferColumns(rows: Record<string, unknown>[], insight: Record<string, unknown>): ColumnMeta[] {
  const apiColumns = Array.isArray(insight.columns) ? insight.columns.filter((value): value is string => typeof value === "string") : [];
  if (apiColumns.length) {
    return apiColumns.map((name) => ({
      name,
      type: "unknown"
    }));
  }

  const names = Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
  return names.map((name) => ({
    name,
    type: inferType(rows.find((row) => row[name] !== null && row[name] !== undefined)?.[name]),
    description: getString(getObject(insight.query)?.kind)
  }));
}

function inferType(value: unknown): string {
  if (value === null || value === undefined) return "unknown";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function getAssetIdSuffix(assetId: string): string {
  const id = assetId.split(":").at(-1);
  if (!id) throw new Error(`Invalid asset id: ${assetId}`);
  return id;
}
