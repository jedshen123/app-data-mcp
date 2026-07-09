#!/usr/bin/env node
import { getMetabaseConfig, getSyncFreshnessConfig } from "../config.js";
import type { ColumnMeta, DataAccessSnapshot, DataAsset } from "../types.js";
import { replacePlatformAssets } from "./catalogFile.js";
import { asArray, fetchJson, getNumber, getObject, getString, joinUrl } from "./http.js";

type MetabaseClient = {
  baseUrl: string;
  headers: HeadersInit;
};

type SyncStats = {
  dashboards: number;
  cards: number;
  totalAssets: number;
  accessSnapshots: number;
};

const config = getMetabaseConfig();

if (config.mode === "missing") {
  console.error(`Metabase config is incomplete: ${config.missing.join(", ")}`);
  process.exit(1);
}

try {
  const client = await createMetabaseClient(config);
  const assets = await syncMetabaseAssets(client);
  const catalog = await replacePlatformAssets("metabase", assets);
  const stats: SyncStats = {
    dashboards: assets.filter((asset) => asset.type === "dashboard").length,
    cards: assets.filter((asset) => asset.type === "card").length,
    totalAssets: assets.length,
    accessSnapshots: assets.filter((asset) => asset.access?.source === "metabase-sync").length
  };

  console.log(
    `Synced Metabase metadata: ${stats.dashboards} dashboards, ${stats.cards} cards, ${stats.accessSnapshots} access snapshots. Catalog now has ${catalog.assets.length} assets.`
  );
} catch (error) {
  console.error("Failed to sync Metabase metadata:", error);
  process.exit(1);
}

async function createMetabaseClient(syncConfig: Exclude<typeof config, { mode: "missing" }>): Promise<MetabaseClient> {
  if (syncConfig.mode === "api-key") {
    return {
      baseUrl: syncConfig.baseUrl,
      headers: {
        "x-api-key": syncConfig.apiKey
      }
    };
  }

  const session = await fetchJson<{ id: string }>(joinUrl(syncConfig.baseUrl, "/api/session"), {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      username: syncConfig.user,
      password: syncConfig.pass
    })
  });

  return {
    baseUrl: syncConfig.baseUrl,
    headers: {
      "X-Metabase-Session": session.id
    }
  };
}

async function syncMetabaseAssets(client: MetabaseClient): Promise<DataAsset[]> {
  const [dashboardsRaw, cardsRaw] = await Promise.all([
    getMetabaseList(client, "/api/dashboard"),
    getMetabaseList(client, "/api/card")
  ]);

  const dashboards = await Promise.all(dashboardsRaw.map((dashboard) => toDashboardAsset(client, dashboard)));
  const cards = cardsRaw.map((card) => toCardAsset(client, card));
  return [...dashboards, ...cards];
}

async function getMetabaseList(client: MetabaseClient, pathname: string): Promise<Record<string, unknown>[]> {
  const value = await fetchJson<unknown>(joinUrl(client.baseUrl, pathname), {
    headers: client.headers
  });
  return asArray<Record<string, unknown>>(value);
}

async function toDashboardAsset(client: MetabaseClient, dashboard: Record<string, unknown>): Promise<DataAsset> {
  const id = String(getNumber(dashboard.id) ?? getString(dashboard.id) ?? "");
  const name = getString(dashboard.name) ?? getString(dashboard.title) ?? `Metabase dashboard ${id}`;
  const description = getString(dashboard.description);
  const collection = getObject(dashboard.collection);
  const children = await readDashboardChildren(client, id);
  const dashboardId = getNumber(dashboard.id);

  return {
    id: `metabase:dashboard:${id}`,
    platform: "metabase",
    type: "dashboard",
    title: name,
    description,
    businessDomain: getString(collection?.name),
    tags: compact(["metabase", "dashboard", getString(collection?.name)]),
    owner: getCreatorName(dashboard),
    url: joinUrl(client.baseUrl, `/dashboard/${id}`),
    updatedAt: getString(dashboard.updated_at) ?? getString(dashboard.created_at),
    children,
    sourceRefs: [
      {
        system: "metabase",
        url: joinUrl(client.baseUrl, `/dashboard/${id}`)
      }
    ],
    access: buildMetabaseAccessSnapshot(dashboard, {
      dashboardId
    }),
    warnings: ["Synced metadata only. This MCP does not write to Metabase."]
  };
}

async function readDashboardChildren(client: MetabaseClient, dashboardId: string): Promise<string[] | undefined> {
  try {
    const detail = await fetchJson<Record<string, unknown>>(joinUrl(client.baseUrl, `/api/dashboard/${dashboardId}`), {
      headers: client.headers
    });
    const dashcards = Array.isArray(detail.dashcards)
      ? detail.dashcards
      : Array.isArray(detail.ordered_cards)
        ? detail.ordered_cards
        : [];
    const children = dashcards
      .filter((dashcard): dashcard is Record<string, unknown> => typeof dashcard === "object" && dashcard !== null)
      .map((dashcard) => getNumber(dashcard.card_id) ?? getNumber(getObject(dashcard.card)?.id))
      .filter((cardId): cardId is number => cardId !== undefined)
      .map((cardId) => `metabase:card:${cardId}`);
    return children.length ? children : undefined;
  } catch {
    return undefined;
  }
}

function toCardAsset(client: MetabaseClient, card: Record<string, unknown>): DataAsset {
  const id = String(getNumber(card.id) ?? getString(card.id) ?? "");
  const name = getString(card.name) ?? getString(card.title) ?? `Metabase card ${id}`;
  const datasetQuery = getObject(card.dataset_query);
  const nativeQuery = getObject(datasetQuery?.native);
  const queryText = getString(nativeQuery?.query) ?? JSON.stringify(datasetQuery ?? {}, null, 2);
  const columns = readMetabaseColumns(card);
  const collection = getObject(card.collection);
  const dashboardId =
    getNumber(card.dashboard_id) ??
    getNumber(card.dashboardId) ??
    getNumber(getObject(card.dashboard)?.id);

  return {
    id: `metabase:card:${id}`,
    platform: "metabase",
    type: "card",
    title: name,
    description: getString(card.description),
    businessDomain: getString(collection?.name),
    tags: compact(["metabase", "card", getString(card.display), getString(collection?.name)]),
    owner: getCreatorName(card),
    url: joinUrl(client.baseUrl, `/question/${id}`),
    updatedAt: getString(card.updated_at) ?? getString(card.created_at),
    queryText,
    columns,
    sourceRefs: [
      {
        system: "metabase",
        url: joinUrl(client.baseUrl, `/question/${id}`)
      }
    ],
    access: buildMetabaseAccessSnapshot(card, {
      dashboardId
    }),
    warnings: ["Synced metadata only. Query execution remains read-only and row-limited."]
  };
}

function buildMetabaseAccessSnapshot(
  value: Record<string, unknown>,
  extra: { dashboardId?: number }
): DataAccessSnapshot {
  const now = new Date().toISOString();
  const syncFreshness = getSyncFreshnessConfig();
  const collection = getObject(value.collection);
  const personalOwnerId =
    getNumber(collection?.personal_owner_id) ??
    getNumber(collection?.personalOwnerId) ??
    getNumber(getObject(collection?.personal_owner)?.id);
  const personalOwnerEmail =
    getString(collection?.personal_owner_email) ??
    getString(getObject(collection?.personal_owner)?.email);
  const archived = Boolean(value.archived);
  const creator = getObject(value.creator);
  const creatorId = getNumber(value.creator_id) ?? getNumber(creator?.id);
  const creatorEmail = getString(value.creator_email) ?? getString(creator?.email);
  const collectionId = getNumber(value.collection_id) ?? getNumber(collection?.id);
  const visibility = archived
    ? "archived"
    : personalOwnerId || personalOwnerEmail
      ? "personal"
      : collectionId
        ? "collection"
        : "unknown";

  return {
    source: "metabase-sync",
    syncedAt: now,
    visibility,
    collectionId,
    collectionName: getString(collection?.name),
    collectionPersonalOwnerId: personalOwnerId,
    collectionPersonalOwnerEmail: personalOwnerEmail,
    dashboardId: extra.dashboardId,
    creatorId,
    creatorEmail,
    archived,
    permissionStaleAfterHours: syncFreshness.metabasePermissionSyncIntervalHours,
    raw: {
      collection_position: value.collection_position,
      collection_authority_level: value.collection_authority_level,
      collection_type: collection?.type,
      collection_location: collection?.location,
      personal_owner_id: personalOwnerId
    }
  };
}

function readMetabaseColumns(card: Record<string, unknown>): ColumnMeta[] | undefined {
  const metadata = asArray<Record<string, unknown>>(card.result_metadata);
  const columns = metadata
    .map((column) => ({
      name: getString(column.name) ?? getString(column.display_name) ?? "",
      type: getString(column.base_type) ?? getString(column.semantic_type) ?? "unknown",
      description: getString(column.description) ?? getString(column.display_name)
    }))
    .filter((column) => column.name);

  return columns.length ? columns : undefined;
}

function getCreatorName(value: Record<string, unknown>): string | undefined {
  const creator = getObject(value.creator) ?? getObject(value.creator_common_name);
  return getString(creator?.common_name) ?? getString(creator?.email) ?? getString(value.creator_common_name);
}

function compact(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value))));
}
