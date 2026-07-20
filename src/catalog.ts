import { z } from "zod";
import { getDataLimitConfig, getMetabasePublicUrl, getMetadataConfig } from "./config.js";
import { readPublishedCatalog } from "./metadataStore.js";
import type { AssetCatalog, DataAsset, DataAssetType, DataPlatform } from "./types.js";

const columnSchema = z.object({
  name: z.string(),
  displayName: z.string().optional(),
  type: z.string(),
  semanticType: z.string().optional(),
  description: z.string().optional(),
  fieldRef: z.unknown().optional()
});

const sourceRefSchema = z.object({
  system: z.string(),
  database: z.string().optional(),
  schema: z.string().optional(),
  table: z.string().optional(),
  fields: z.array(z.string()).optional(),
  events: z.array(z.string()).optional(),
  assetId: z.string().optional(),
  url: z.string().optional()
});

const accessSnapshotSchema = z.object({
  source: z.enum(["metabase-sync", "posthog-sync", "local-config"]),
  syncedAt: z.string(),
  visibility: z.enum(["unknown", "collection", "personal", "archived", "public"]),
  collectionId: z.number().optional(),
  collectionName: z.string().optional(),
  collectionPersonalOwnerId: z.number().optional(),
  collectionPersonalOwnerEmail: z.string().optional(),
  dashboardId: z.number().optional(),
  creatorId: z.number().optional(),
  creatorEmail: z.string().optional(),
  archived: z.boolean().optional(),
  permissionStaleAfterHours: z.number().optional(),
  raw: z.record(z.unknown()).optional()
});

const parameterSchema = z.object({
  name: z.string(),
  label: z.string().optional(),
  type: z.enum(["date", "date_range", "category", "number", "string", "boolean", "unknown"]),
  required: z.boolean().optional(),
  defaultValue: z.unknown().optional(),
  allowedValues: z.array(z.string()).optional(),
  description: z.string().optional(),
  platformTarget: z.unknown().optional(),
  raw: z.record(z.unknown()).optional()
});

const dashboardParameterMappingSchema = z.object({
  parameterId: z.string(),
  parameterName: z.string().optional(),
  cardId: z.string(),
  dashcardId: z.string().optional(),
  cardTitle: z.string().optional(),
  target: z.unknown().optional(),
  parameterType: z.string().optional(),
  raw: z.record(z.unknown()).optional()
});

const metricMetadataSchema = z.object({
  formula: z.unknown().optional(),
  filters: z.array(z.unknown()).optional(),
  dataSource: z.object({
    kind: z.enum(["table", "card", "model", "metric", "unknown"]),
    id: z.string(),
    assetId: z.string().optional(),
    title: z.string().optional()
  }).optional(),
  defaultTimeDimension: z.object({
    field: z.unknown(),
    name: z.string().optional(),
    displayName: z.string().optional(),
    unit: z.string().optional()
  }).optional(),
  dimensions: z.array(columnSchema).optional(),
  upstreamAssets: z.array(z.string()).optional(),
  downstreamAssets: z.array(z.string()).optional(),
  queryDescription: z.string().optional()
});

const assetSchema = z.object({
  id: z.string(),
  platform: z.enum(["metabase", "posthog", "local"]),
  type: z.enum(["dashboard", "card", "model", "insight", "metric", "table", "event"]),
  title: z.string(),
  description: z.string().optional(),
  businessDomain: z.string().optional(),
  tags: z.array(z.string()).default([]),
  owner: z.string().optional(),
  url: z.string(),
  updatedAt: z.string().optional(),
  popularity: z.number().optional(),
  children: z.array(z.string()).optional(),
  queryText: z.string().optional(),
  columns: z.array(columnSchema).optional(),
  sourceRefs: z.array(sourceRefSchema).optional(),
  sampleData: z
    .object({
      columns: z.array(columnSchema),
      rows: z.array(z.record(z.unknown()))
    })
    .optional(),
  parameters: z.array(parameterSchema).optional(),
  dashboardParameterMappings: z.array(dashboardParameterMappingSchema).optional(),
  metric: metricMetadataSchema.optional(),
  access: accessSnapshotSchema.optional(),
  warnings: z.array(z.string()).optional()
});

const catalogSchema = z.object({
  version: z.number(),
  updatedAt: z.string().optional(),
  assets: z.array(assetSchema)
});

export type SearchAssetsInput = {
  query: string;
  platform?: DataPlatform;
  type?: DataAssetType;
  domain?: string;
  limit?: number;
};

export class CatalogStore {
  static fromEnv(): CatalogStore {
    return new CatalogStore();
  }

  get path(): string {
    const config = getMetadataConfig();
    return `${config.schema}.${config.table}`;
  }

  async load(): Promise<AssetCatalog> {
    const parsed = catalogSchema.parse(await readPublishedCatalog());
    return rewriteCatalogPublicUrls(parsed);
  }

  async getCatalog(): Promise<AssetCatalog> {
    return this.load();
  }

  async findById(id: string): Promise<DataAsset | undefined> {
    const catalog = await this.getCatalog();
    return catalog.assets.find((asset) => asset.id === id);
  }

  async listDomains(): Promise<string[]> {
    const catalog = await this.getCatalog();
    return Array.from(
      new Set(catalog.assets.map((asset) => asset.businessDomain).filter(Boolean) as string[])
    ).sort();
  }

  async status() {
    try {
      const catalog = await this.getCatalog();
      const byPlatform = countBy(catalog.assets, (asset) => asset.platform);
      const byType = countBy(catalog.assets, (asset) => asset.type);

      return {
        initialized: true,
        path: this.path,
        version: catalog.version,
        updatedAt: catalog.updatedAt,
        assetCount: catalog.assets.length,
        byPlatform,
        byType
      };
    } catch (error) {
      return {
        initialized: false,
        path: this.path,
        error: error instanceof Error ? error.message : String(error),
        assetCount: 0,
        byPlatform: {},
        byType: {}
      };
    }
  }

  async search(input: SearchAssetsInput): Promise<DataAsset[]> {
    const catalog = await this.getCatalog();
    const limits = getDataLimitConfig();
    const limit = Math.min(Math.max(input.limit ?? limits.defaultSearchLimit, 1), limits.maxSearchLimit);
    return searchCatalogAssets(catalog.assets, input, limit);
  }
}

export function searchCatalogAssets(assets: DataAsset[], input: SearchAssetsInput, limit: number): DataAsset[] {
  const signals = buildSearchSignals(input.query);
  return assets
    .filter((asset) => {
      if (input.platform && asset.platform !== input.platform) return false;
      if (input.type && asset.type !== input.type) return false;
      if (input.domain && asset.businessDomain !== input.domain) return false;
      return true;
    })
    .map((asset) => ({ asset, score: scoreAsset(asset, signals) }))
    .filter(({ score }) => signals.tokens.length === 0 || score > 0)
    .sort((left, right) => right.score - left.score || left.asset.title.localeCompare(right.asset.title, "zh-CN"))
    .slice(0, limit)
    .map(({ asset }) => asset);
}

function countBy<T>(items: T[], getKey: (item: T) => string): Record<string, number> {
  return items.reduce<Record<string, number>>((counts, item) => {
    const key = getKey(item);
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

function normalize(value: string | undefined): string {
  return (value ?? "").toLowerCase().trim();
}

type SearchSignals = {
  normalizedQuery: string;
  tokens: string[];
};

const SEARCH_STOP_TOKENS = new Set([
  "帮我", "请使", "使用", "查询", "数据", "一下", "最近", "进行", "统计", "趋势", "相关", "看看"
]);

function buildSearchSignals(query: string): SearchSignals {
  const normalizedQuery = normalize(query).replace(/[^a-z0-9_\u3400-\u9fff]+/g, " ");
  const tokens = new Set<string>();
  for (const ascii of normalizedQuery.match(/[a-z0-9_]+/g) ?? []) {
    if (ascii.length >= 2) tokens.add(ascii);
  }
  for (const sequence of normalizedQuery.match(/[\u3400-\u9fff]+/g) ?? []) {
    if (sequence.length <= 4 && !SEARCH_STOP_TOKENS.has(sequence)) tokens.add(sequence);
    for (const size of [2, 3]) {
      for (let index = 0; index <= sequence.length - size; index += 1) {
        const token = sequence.slice(index, index + size);
        if (!SEARCH_STOP_TOKENS.has(token)) tokens.add(token);
      }
    }
  }
  return { normalizedQuery: normalizedQuery.trim(), tokens: Array.from(tokens) };
}

function scoreAsset(asset: DataAsset, signals: SearchSignals): number {
  const popularity = asset.popularity ?? 0;
  if (signals.tokens.length === 0) return popularity;

  const title = normalize(asset.title);
  const tags = normalize(asset.tags.join(" "));
  const description = normalize(asset.description);
  const domain = normalize(asset.businessDomain);
  const queryText = normalize(asset.queryText);
  const fields = normalize([
    asset.columns?.map((column) => `${column.name} ${column.displayName ?? ""} ${column.description ?? ""}`).join(" "),
    asset.metric?.dimensions?.map((column) => `${column.name} ${column.displayName ?? ""} ${column.description ?? ""}`).join(" "),
    asset.metric?.queryDescription
  ].filter(Boolean).join(" "));
  let matchedTokens = 0;
  let score = popularity / 10;
  if (signals.normalizedQuery && `${title} ${description}`.includes(signals.normalizedQuery)) score += 80;
  for (const token of signals.tokens) {
    let matched = false;
    if (title.includes(token)) { score += 20; matched = true; }
    if (tags.includes(token)) { score += 12; matched = true; }
    if (description.includes(token)) { score += 10; matched = true; }
    if (domain.includes(token)) { score += 8; matched = true; }
    if (fields.includes(token)) { score += 5; matched = true; }
    if (queryText.includes(token)) { score += 2; matched = true; }
    if (matched) matchedTokens += 1;
  }
  const minimumMatches = signals.tokens.length <= 2 ? 1 : 2;
  if (matchedTokens < minimumMatches) return 0;
  if (asset.type === "metric") score += 18;
  else if (asset.type === "model") score += 10;
  else if (asset.type === "card") score += 4;
  return score + (matchedTokens / signals.tokens.length) * 20;
}

function rewriteCatalogPublicUrls(catalog: AssetCatalog): AssetCatalog {
  const metabasePublicUrl = getMetabasePublicUrl();
  if (!metabasePublicUrl) return catalog;

  return {
    ...catalog,
    assets: catalog.assets.map((asset) => {
      if (asset.platform !== "metabase") return asset;
      return {
        ...asset,
        url: rewriteUrlBase(asset.url, metabasePublicUrl),
        sourceRefs: asset.sourceRefs?.map((sourceRef) => ({
          ...sourceRef,
          url: sourceRef.url ? rewriteUrlBase(sourceRef.url, metabasePublicUrl) : sourceRef.url
        }))
      };
    })
  };
}

function rewriteUrlBase(url: string, publicBaseUrl: string): string {
  try {
    const parsed = new URL(url);
    return joinPublicUrl(publicBaseUrl, `${parsed.pathname}${parsed.search}${parsed.hash}`);
  } catch {
    return url;
  }
}

function joinPublicUrl(baseUrl: string, path: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${base}${suffix}`;
}
