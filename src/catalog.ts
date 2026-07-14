import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { getAssetFilePath, getDataLimitConfig, getMetabasePublicUrl } from "./config.js";
import type { AssetCatalog, DataAsset, DataAssetType, DataPlatform } from "./types.js";

const columnSchema = z.object({
  name: z.string(),
  type: z.string(),
  description: z.string().optional()
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

const assetSchema = z.object({
  id: z.string(),
  platform: z.enum(["metabase", "posthog", "local"]),
  type: z.enum(["dashboard", "card", "insight", "metric", "table", "event"]),
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
  private catalog: AssetCatalog | null = null;

  constructor(private readonly filePath: string) {}

  static fromEnv(): CatalogStore {
    const configuredPath = getAssetFilePath();
    return new CatalogStore(path.resolve(process.cwd(), configuredPath));
  }

  get path(): string {
    return this.filePath;
  }

  async load(): Promise<AssetCatalog> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        throw new Error(
          `Asset catalog is not initialized: ${this.filePath}. Run "npm run init:assets" first.`
        );
      }
      throw error;
    }

    const parsed = catalogSchema.parse(JSON.parse(raw));
    this.catalog = rewriteCatalogPublicUrls(parsed);
    return this.catalog;
  }

  async getCatalog(): Promise<AssetCatalog> {
    return this.catalog ?? this.load();
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
        path: this.filePath,
        version: catalog.version,
        updatedAt: catalog.updatedAt,
        assetCount: catalog.assets.length,
        byPlatform,
        byType
      };
    } catch (error) {
      return {
        initialized: false,
        path: this.filePath,
        error: error instanceof Error ? error.message : String(error),
        assetCount: 0,
        byPlatform: {},
        byType: {}
      };
    }
  }

  async search(input: SearchAssetsInput): Promise<DataAsset[]> {
    const catalog = await this.getCatalog();
    const query = normalize(input.query);
    const terms = query.split(/\s+/).filter(Boolean);
    const limits = getDataLimitConfig();
    const limit = Math.min(Math.max(input.limit ?? limits.defaultSearchLimit, 1), limits.maxSearchLimit);

    return catalog.assets
      .filter((asset) => {
        if (input.platform && asset.platform !== input.platform) return false;
        if (input.type && asset.type !== input.type) return false;
        if (input.domain && asset.businessDomain !== input.domain) return false;
        if (terms.length === 0) return true;

        const haystack = normalize(
          [
            asset.id,
            asset.title,
            asset.description,
            asset.businessDomain,
            asset.owner,
            asset.tags.join(" "),
            asset.queryText,
            asset.columns?.map((column) => `${column.name} ${column.description ?? ""}`).join(" "),
            asset.parameters?.map((parameter) => `${parameter.name} ${parameter.label ?? ""} ${parameter.description ?? ""}`).join(" "),
            asset.dashboardParameterMappings
              ?.map((mapping) => `${mapping.parameterId} ${mapping.parameterName ?? ""} ${mapping.cardTitle ?? ""}`)
              .join(" ")
          ]
            .filter(Boolean)
            .join(" ")
        );

        return terms.every((term) => haystack.includes(term));
      })
      .map((asset) => ({ asset, score: scoreAsset(asset, terms) }))
      .sort((left, right) => right.score - left.score)
      .slice(0, limit)
      .map(({ asset }) => asset);
  }
}

function countBy<T>(items: T[], getKey: (item: T) => string): Record<string, number> {
  return items.reduce<Record<string, number>>((counts, item) => {
    const key = getKey(item);
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function normalize(value: string | undefined): string {
  return (value ?? "").toLowerCase().trim();
}

function scoreAsset(asset: DataAsset, terms: string[]): number {
  const popularity = asset.popularity ?? 0;
  if (terms.length === 0) return popularity;

  const title = normalize(asset.title);
  const tags = normalize(asset.tags.join(" "));
  const description = normalize(asset.description);
  const queryText = normalize(asset.queryText);

  return terms.reduce((score, term) => {
    if (title.includes(term)) score += 20;
    if (tags.includes(term)) score += 12;
    if (description.includes(term)) score += 8;
    if (queryText.includes(term)) score += 4;
    return score;
  }, popularity / 10);
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
