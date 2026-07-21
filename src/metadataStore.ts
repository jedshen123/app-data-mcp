import fs from "node:fs";
import { Pool } from "pg";
import { getAuditConfig, getMetadataConfig } from "./config.js";
import type { AssetCatalog, DataAsset, DataAssetType, DataPlatform } from "./types.js";

export type ManagedAsset = {
  asset: DataAsset;
  published: boolean;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  lastSyncedAt: string;
};

export type ManagedAssetPatch = {
  published?: boolean;
  title?: string;
  description?: string | null;
  businessDomain?: string | null;
  tags?: string[];
};

export type ManagedAssetSort =
  | "asset_id"
  | "title"
  | "type"
  | "business_domain"
  | "published"
  | "active"
  | "last_synced_at"
  | "updated_at";

export type AuditLogFilters = {
  user?: string;
  tool?: string;
  status?: string;
  limit?: number;
  offset?: number;
};

export type AuditLogRow = {
  id: string;
  createdAt: string;
  userEmail?: string;
  authMethod?: string;
  aiClient?: string;
  toolName: string;
  assetId?: string;
  assetPlatform?: string;
  status: string;
  rowCount?: number;
  durationMs?: number;
  clientIp?: string;
  errorCode?: string;
  errorMessage?: string;
};

let pool: Pool | undefined;
let initialized = false;
let initializationPromise: Promise<void> | undefined;

export async function readPublishedCatalog(): Promise<AssetCatalog> {
  const client = await getMetadataPool();
  await ensureMetadataTable(client);
  const config = getMetadataConfig();
  const result = await client.query<{ metadata: DataAsset; admin_overrides: Record<string, unknown>; last_synced_at: Date }>(
    `select metadata, admin_overrides, last_synced_at from ${qualifiedName(config.schema, config.table)}
     where is_published = true and is_active = true
     order by asset_id`
  );
  const latest = result.rows.reduce<number | undefined>((current, row) => {
    const value = new Date(row.last_synced_at).getTime();
    return current === undefined || value > current ? value : current;
  }, undefined);
  return {
    version: 1,
    updatedAt: latest === undefined ? undefined : new Date(latest).toISOString(),
    assets: result.rows.map((row) => mergeAssetOverrides(row.metadata, row.admin_overrides))
  };
}

export async function upsertPlatformAssets(platform: DataPlatform, assets: DataAsset[]): Promise<{
  platform: DataPlatform;
  synced: number;
  active: number;
}> {
  const pool = await getMetadataPool();
  await ensureMetadataTable(pool);
  const connection = await pool.connect();
  const config = getMetadataConfig();
  const tableName = qualifiedName(config.schema, config.table);
  const uniqueAssets = dedupeAssets(assets);
  try {
    await connection.query("begin");
    await connection.query(`update ${tableName} set is_active = false, updated_at = now() where platform = $1`, [platform]);
    for (const asset of uniqueAssets) {
      const previousAssetIds = getPreviousMetabaseAssetIds(asset);
      for (const previousAssetId of previousAssetIds) {
        await connection.query(
          `update ${tableName}
           set asset_id = $1, updated_at = now()
           where asset_id = $2
             and not exists (select 1 from ${tableName} where asset_id = $1)`,
          [asset.id, previousAssetId]
        );
      }
      await connection.query(
        `insert into ${tableName} (
          asset_id, platform, asset_type, title, metadata, is_published, is_active,
          source_updated_at, last_synced_at, created_at, updated_at
        ) values ($1, $2, $3, $4, $5::jsonb, $6, true, $7, now(), now(), now())
        on conflict (asset_id) do update set
          platform = excluded.platform,
          asset_type = excluded.asset_type,
          title = excluded.title,
          metadata = excluded.metadata,
          is_active = true,
          source_updated_at = excluded.source_updated_at,
          last_synced_at = now(),
          updated_at = now()`,
        [
          asset.id,
          asset.platform,
          asset.type,
          asset.title,
          JSON.stringify(asset),
          config.defaultPublished,
          parseTimestamp(asset.updatedAt)
        ]
      );
    }
    await connection.query(
      `update ${tableName}
       set is_published = false, updated_at = now()
       where platform = $1 and is_active = false and is_published = true`,
      [platform]
    );
    await connection.query("commit");
    return { platform, synced: uniqueAssets.length, active: uniqueAssets.length };
  } catch (error) {
    await connection.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    connection.release();
  }
}

export async function listManagedAssets(input: {
  platform?: DataPlatform;
  assetType?: DataAssetType;
  businessDomain?: string;
  query?: string;
  published?: boolean;
  limit?: number;
  offset?: number;
  sort?: ManagedAssetSort;
  order?: "asc" | "desc";
}): Promise<{ assets: ManagedAsset[]; total: number }> {
  const client = await getMetadataPool();
  await ensureMetadataTable(client);
  const config = getMetadataConfig();
  const tableName = qualifiedName(config.schema, config.table);
  const conditions: string[] = [];
  const values: unknown[] = [];
  if (input.platform) {
    values.push(input.platform);
    conditions.push(`platform = $${values.length}`);
  }
  if (input.assetType) {
    values.push(input.assetType);
    conditions.push(`asset_type = $${values.length}`);
  }
  if (input.businessDomain?.trim()) {
    values.push(input.businessDomain.trim());
    conditions.push(`coalesce(admin_overrides->>'businessDomain', metadata->>'businessDomain') = $${values.length}`);
  }
  if (input.published !== undefined) {
    values.push(input.published);
    conditions.push(`is_published = $${values.length}`);
  }
  if (input.query?.trim()) {
    values.push(`%${input.query.trim()}%`);
    conditions.push(`(asset_id ilike $${values.length} or title ilike $${values.length} or coalesce(admin_overrides->>'title', metadata->>'title') ilike $${values.length})`);
  }
  const where = conditions.length ? `where ${conditions.join(" and ")}` : "";
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const offset = Math.max(input.offset ?? 0, 0);
  const sortExpression = managedAssetSortExpression(input.sort ?? "updated_at");
  const sortOrder = input.order === "asc" ? "asc" : "desc";
  const countResult = await client.query<{ count: string }>(`select count(*)::text as count from ${tableName} ${where}`, values);
  values.push(limit, offset);
  const result = await client.query<{
    metadata: DataAsset;
    admin_overrides: Record<string, unknown>;
    is_published: boolean;
    is_active: boolean;
    created_at: Date;
    updated_at: Date;
    last_synced_at: Date;
  }>(
    `select metadata, admin_overrides, is_published, is_active, created_at, updated_at, last_synced_at
     from ${tableName} ${where}
     order by ${sortExpression} ${sortOrder} nulls last, asset_id asc
     limit $${values.length - 1} offset $${values.length}`,
    values
  );
  return {
    total: Number.parseInt(countResult.rows[0]?.count ?? "0", 10),
    assets: result.rows.map((row) => ({
      asset: mergeAssetOverrides(row.metadata, row.admin_overrides),
      published: row.is_published,
      active: row.is_active,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      lastSyncedAt: row.last_synced_at.toISOString()
    }))
  };
}

export async function listManagedAssetDomains(platform?: DataPlatform): Promise<string[]> {
  const client = await getMetadataPool();
  await ensureMetadataTable(client);
  const config = getMetadataConfig();
  const tableName = qualifiedName(config.schema, config.table);
  const values: unknown[] = [];
  const where = platform ? "where platform = $1" : "";
  if (platform) values.push(platform);
  const result = await client.query<{ business_domain: string }>(
    `select distinct coalesce(admin_overrides->>'businessDomain', metadata->>'businessDomain') as business_domain
     from ${tableName}
     ${where}
     order by business_domain asc`,
    values
  );
  return result.rows.map((row) => row.business_domain).filter(Boolean);
}

export async function listManagedAssetTypes(platform?: DataPlatform): Promise<DataAssetType[]> {
  const client = await getMetadataPool();
  await ensureMetadataTable(client);
  const config = getMetadataConfig();
  const tableName = qualifiedName(config.schema, config.table);
  const values: unknown[] = [];
  const where = platform ? "where platform = $1" : "";
  if (platform) values.push(platform);
  const result = await client.query<{ asset_type: DataAssetType }>(
    `select distinct asset_type from ${tableName} ${where} order by asset_type asc`,
    values
  );
  return result.rows.map((row) => row.asset_type);
}

export async function bulkUpdateManagedAssets(assetIds: string[], published: boolean): Promise<number> {
  const client = await getMetadataPool();
  await ensureMetadataTable(client);
  const config = getMetadataConfig();
  const tableName = qualifiedName(config.schema, config.table);
  const uniqueIds = Array.from(new Set(assetIds.map((value) => value.trim()).filter(Boolean))).slice(0, 500);
  if (!uniqueIds.length) return 0;
  const result = await client.query(
    `update ${tableName}
     set is_published = $2, updated_at = now()
     where asset_id = any($1::text[])${published ? " and is_active = true" : ""}`,
    [uniqueIds, published]
  );
  return result.rowCount ?? 0;
}

export async function updateManagedAsset(assetId: string, patch: ManagedAssetPatch): Promise<ManagedAsset | undefined> {
  const client = await getMetadataPool();
  await ensureMetadataTable(client);
  const config = getMetadataConfig();
  const tableName = qualifiedName(config.schema, config.table);
  const current = await client.query<{ metadata: DataAsset; admin_overrides: Record<string, unknown> }>(
    `select metadata, admin_overrides from ${tableName} where asset_id = $1`,
    [assetId]
  );
  const asset = current.rows[0]?.metadata;
  if (!asset) return undefined;
  const overrides: Record<string, unknown> = { ...(current.rows[0]?.admin_overrides ?? {}) };
  if (patch.title !== undefined) overrides.title = patch.title;
  if (patch.description !== undefined) overrides.description = patch.description;
  if (patch.businessDomain !== undefined) overrides.businessDomain = patch.businessDomain;
  if (patch.tags !== undefined) overrides.tags = patch.tags;
  const published = patch.published;
  const result = await client.query<{
    metadata: DataAsset;
    admin_overrides: Record<string, unknown>;
    is_published: boolean;
    is_active: boolean;
    created_at: Date;
    updated_at: Date;
    last_synced_at: Date;
  }>(
    `update ${tableName} set
       title = $2,
       admin_overrides = $3::jsonb,
       is_published = coalesce($4, is_published),
       updated_at = now()
     where asset_id = $1
     returning metadata, admin_overrides, is_published, is_active, created_at, updated_at, last_synced_at`,
    [assetId, patch.title ?? mergeAssetOverrides(asset, overrides).title, JSON.stringify(overrides), published]
  );
  const row = result.rows[0];
  if (!row) return undefined;
  return {
    asset: mergeAssetOverrides(row.metadata, row.admin_overrides),
    published: row.is_published,
    active: row.is_active,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    lastSyncedAt: row.last_synced_at.toISOString()
  };
}

export async function listAuditLogs(input: AuditLogFilters): Promise<{ logs: AuditLogRow[]; total: number }> {
  const client = await getMetadataPool();
  const config = getAuditConfig();
  const tableName = qualifiedName(config.schema, config.table);
  const exists = await client.query<{ relation: string | null }>("select to_regclass($1) as relation", [tableName]);
  if (!exists.rows[0]?.relation) return { logs: [], total: 0 };

  const conditions: string[] = [];
  const values: unknown[] = [];
  if (input.user?.trim()) {
    values.push(`%${input.user.trim()}%`);
    conditions.push(`user_email ilike $${values.length}`);
  }
  if (input.tool?.trim()) {
    values.push(input.tool.trim());
    conditions.push(`tool_name = $${values.length}`);
  }
  if (input.status?.trim()) {
    values.push(input.status.trim());
    conditions.push(`status = $${values.length}`);
  }
  const where = conditions.length ? `where ${conditions.join(" and ")}` : "";
  const countResult = await client.query<{ count: string }>(`select count(*)::text as count from ${tableName} ${where}`, values);
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
  const offset = Math.max(input.offset ?? 0, 0);
  values.push(limit, offset);
  const result = await client.query<{
    id: string;
    created_at: Date;
    user_email?: string;
    auth_method?: string;
    ai_client?: string;
    tool_name: string;
    asset_id?: string;
    asset_platform?: string;
    status: string;
    row_count?: number;
    duration_ms?: number;
    client_ip?: string;
    error_code?: string;
    error_message?: string;
  }>(
    `select id::text, created_at, user_email, auth_method, ai_client, tool_name, asset_id,
            asset_platform, status, row_count, duration_ms, client_ip, error_code, error_message
     from ${tableName} ${where}
     order by created_at desc
     limit $${values.length - 1} offset $${values.length}`,
    values
  );
  return {
    total: Number.parseInt(countResult.rows[0]?.count ?? "0", 10),
    logs: result.rows.map((row) => ({
      id: row.id,
      createdAt: row.created_at.toISOString(),
      userEmail: row.user_email,
      authMethod: row.auth_method,
      aiClient: row.ai_client,
      toolName: row.tool_name,
      assetId: row.asset_id,
      assetPlatform: row.asset_platform,
      status: row.status,
      rowCount: row.row_count,
      durationMs: row.duration_ms,
      clientIp: row.client_ip,
      errorCode: row.error_code,
      errorMessage: row.error_message
    }))
  };
}

export async function getMetadataPool(): Promise<Pool> {
  const config = getMetadataConfig();
  if (config.dbType !== "postgres" || !config.host || !config.user || !config.database) {
    throw new Error("PostgreSQL metadata storage requires DB_TYPE=postgres and DB_HOST, DB_USER, DB_NAME.");
  }
  if (!pool) {
    pool = new Pool({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
      ssl: config.ssl
        ? {
            rejectUnauthorized: config.sslRejectUnauthorized,
            ...(config.sslCaFile ? { ca: fs.readFileSync(config.sslCaFile, "utf8") } : {})
          }
        : undefined
    });
    pool.on("error", (error) => console.error("Unexpected metadata PostgreSQL pool error:", error));
  }
  return pool;
}

export async function ensureMetadataTable(client?: Pool): Promise<void> {
  if (initialized) return;
  const target = client ?? await getMetadataPool();
  initializationPromise ??= initializeMetadataTable(target).catch((error) => {
    initializationPromise = undefined;
    throw error;
  });
  await initializationPromise;
  initialized = true;
}

async function initializeMetadataTable(pool: Pool): Promise<void> {
  const connection = await pool.connect();
  const config = getMetadataConfig();
  const tableName = qualifiedName(config.schema, config.table);
  try {
    await connection.query("begin");
    await connection.query("select pg_advisory_xact_lock(hashtext($1))", [`app-data-mcp-metadata:${tableName}`]);
    await connection.query(`create table if not exists ${tableName} (
      asset_id text primary key,
      platform text not null,
      asset_type text not null,
      title text not null,
      metadata jsonb not null,
      admin_overrides jsonb not null default '{}'::jsonb,
      is_published boolean not null default false,
      is_active boolean not null default true,
      source_updated_at timestamptz,
      last_synced_at timestamptz not null default now(),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )`);
    await connection.query(`alter table ${tableName} add column if not exists admin_overrides jsonb not null default '{}'::jsonb`);
    await connection.query(`create index if not exists ${quoteIdentifier(`${config.table}_platform_idx`)} on ${tableName} (platform, is_active)`);
    await connection.query(`create index if not exists ${quoteIdentifier(`${config.table}_published_idx`)} on ${tableName} (is_published, is_active)`);
    await connection.query(`create index if not exists ${quoteIdentifier(`${config.table}_updated_idx`)} on ${tableName} (updated_at desc)`);
    await connection.query("commit");
  } catch (error) {
    await connection.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    connection.release();
  }
}

function dedupeAssets(assets: DataAsset[]): DataAsset[] {
  return Array.from(new Map(assets.map((asset) => [asset.id, asset])).values());
}

function getPreviousMetabaseAssetIds(asset: DataAsset): string[] {
  if (asset.platform !== "metabase") return [];
  const match = /^metabase:(card|model|metric):(.+)$/.exec(asset.id);
  if (!match) return [];
  return ["card", "model", "metric"]
    .filter((type) => type !== match[1])
    .map((type) => `metabase:${type}:${match[2]}`);
}

function parseTimestamp(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : undefined;
}

function mergeAssetOverrides(asset: DataAsset, overrides: Record<string, unknown> | undefined): DataAsset {
  const merged = { ...asset, ...(overrides ?? {}) } as DataAsset & Record<string, unknown>;
  if (merged.description === null) delete merged.description;
  if (merged.businessDomain === null) delete merged.businessDomain;
  return merged;
}

function managedAssetSortExpression(sort: ManagedAssetSort): string {
  switch (sort) {
    case "asset_id": return "asset_id";
    case "title": return "coalesce(admin_overrides->>'title', metadata->>'title')";
    case "type": return "asset_type";
    case "business_domain": return "coalesce(admin_overrides->>'businessDomain', metadata->>'businessDomain')";
    case "published": return "is_published";
    case "active": return "is_active";
    case "last_synced_at": return "last_synced_at";
    case "updated_at": return "updated_at";
  }
}

export function qualifiedName(schema: string, table: string): string {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
}

export function quoteIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`Invalid SQL identifier: ${value}`);
  return `"${value}"`;
}
