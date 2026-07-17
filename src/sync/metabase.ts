#!/usr/bin/env node
import { getMetabaseConfig, getMetabasePublicUrl, getSyncFreshnessConfig } from "../config.js";
import { upsertPlatformAssets } from "../metadataStore.js";
import type {
  AssetParameter,
  ColumnMeta,
  DashboardParameterMapping,
  DataAccessSnapshot,
  DataAsset
} from "../types.js";
import { asArray, fetchJson, getNumber, getObject, getString, joinUrl } from "./http.js";

type MetabaseClient = {
  baseUrl: string;
  publicUrl: string;
  headers: HeadersInit;
};

type SyncStats = {
  dashboards: number;
  cards: number;
  models: number;
  totalAssets: number;
  accessSnapshots: number;
};

const CARD_DETAIL_CONCURRENCY = 8;

const config = getMetabaseConfig();

if (config.mode === "missing") {
  console.error(`Metabase config is incomplete: ${config.missing.join(", ")}`);
  process.exit(1);
}

try {
  const client = await createMetabaseClient(config);
  const assets = await syncMetabaseAssets(client);
  const result = await upsertPlatformAssets("metabase", assets);
  const stats: SyncStats = {
    dashboards: assets.filter((asset) => asset.type === "dashboard").length,
    cards: assets.filter((asset) => asset.type === "card").length,
    models: assets.filter((asset) => asset.type === "model").length,
    totalAssets: assets.length,
    accessSnapshots: assets.filter((asset) => asset.access?.source === "metabase-sync").length
  };

  console.log(
    `Synced Metabase metadata to PostgreSQL: ${stats.dashboards} dashboards, ${stats.cards} cards, ${stats.models} models, ${stats.accessSnapshots} access snapshots, ${result.synced} upserted.`
  );
} catch (error) {
  console.error("Failed to sync Metabase metadata:", error);
  process.exit(1);
}

async function createMetabaseClient(syncConfig: Exclude<typeof config, { mode: "missing" }>): Promise<MetabaseClient> {
  if (syncConfig.mode === "api-key") {
    return {
      baseUrl: syncConfig.baseUrl,
      publicUrl: getMetabasePublicUrl() ?? syncConfig.baseUrl,
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
    publicUrl: getMetabasePublicUrl() ?? syncConfig.baseUrl,
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
  const cards = await mapWithConcurrency(cardsRaw, CARD_DETAIL_CONCURRENCY, async (card) => {
    const id = String(getNumber(card.id) ?? getString(card.id) ?? "");
    const detail = id ? await readCardDetail(client, id) : undefined;
    return toCardAsset(client, detail ? { ...card, ...detail } : card, {
      detailLoaded: Boolean(detail)
    });
  });
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
  const detail = await readDashboardDetail(client, id);
  const children = readDashboardChildren(detail);
  const parameters = readMetabaseDashboardParameters(detail);
  const dashboardParameterMappings = readMetabaseDashboardParameterMappings(detail, parameters);
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
    url: joinUrl(client.publicUrl, `/dashboard/${id}`),
    updatedAt: getString(dashboard.updated_at) ?? getString(dashboard.created_at),
    children,
    parameters,
    dashboardParameterMappings,
    sourceRefs: [
      {
        system: "metabase",
        url: joinUrl(client.publicUrl, `/dashboard/${id}`)
      }
    ],
    access: buildMetabaseAccessSnapshot(dashboard, {
      dashboardId
    }),
    warnings: ["Synced metadata only. This MCP does not write to Metabase."]
  };
}

async function readDashboardDetail(client: MetabaseClient, dashboardId: string): Promise<Record<string, unknown> | undefined> {
  try {
    return await fetchJson<Record<string, unknown>>(joinUrl(client.baseUrl, `/api/dashboard/${dashboardId}`), {
      headers: client.headers
    });
  } catch {
    return undefined;
  }
}

async function readCardDetail(client: MetabaseClient, cardId: string): Promise<Record<string, unknown> | undefined> {
  try {
    return await fetchJson<Record<string, unknown>>(joinUrl(client.baseUrl, `/api/card/${cardId}`), {
      headers: client.headers
    });
  } catch (error) {
    console.warn(`Unable to read Metabase card detail for card ${cardId}; using list metadata instead.`, error);
    return undefined;
  }
}

function readDashboardChildren(detail: Record<string, unknown> | undefined): string[] | undefined {
  const dashcards = Array.isArray(detail?.dashcards)
    ? detail.dashcards
    : Array.isArray(detail?.ordered_cards)
      ? detail.ordered_cards
      : [];
  const children = dashcards
    .filter((dashcard): dashcard is Record<string, unknown> => typeof dashcard === "object" && dashcard !== null)
    .flatMap((dashcard): string[] => {
      const card = getObject(dashcard.card);
      const cardId = getNumber(dashcard.card_id) ?? getNumber(card?.id);
      if (cardId === undefined) return [];
      return [`metabase:${isMetabaseModel(card) ? "model" : "card"}:${cardId}`];
    });
  return children.length ? children : undefined;
}

function readMetabaseDashboardParameterMappings(
  detail: Record<string, unknown> | undefined,
  parameters: AssetParameter[] | undefined
): DashboardParameterMapping[] | undefined {
  const parameterById = new Map((parameters ?? []).map((parameter) => [parameter.name, parameter]));
  const dashcards = readRawDashboardCards(detail);
  const mappings = dashcards.flatMap((dashcard): DashboardParameterMapping[] => {
    const card = getObject(dashcard.card);
    const cardId = getNumber(dashcard.card_id) ?? getNumber(card?.id);
    if (cardId === undefined) return [];

    const dashcardId = getNumber(dashcard.id) ?? getNumber(dashcard.dashboard_card_id);
    const cardTitle = getString(card?.name) ?? getString(dashcard.title);
    return asArray<Record<string, unknown>>(dashcard.parameter_mappings).flatMap((mapping) => {
      const parameterId =
        getString(mapping.parameter_id) ??
        getString(mapping.parameterId) ??
        getString(getObject(mapping.parameter)?.id);
      if (!parameterId) return [];
      const parameter = parameterById.get(parameterId);
      return [{
        parameterId,
        parameterName: parameter?.label ?? parameter?.name,
        cardId: String(cardId),
        dashcardId: dashcardId === undefined ? undefined : String(dashcardId),
        cardTitle,
        target: mapping.target,
        parameterType: getString(mapping.parameter_type) ?? getString(mapping.parameterType) ?? getString(parameter?.raw?.type),
        raw: pickRaw(mapping, ["parameter_id", "card_id", "target", "parameter_type"])
      }];
    });
  });

  return mappings.length ? mappings : undefined;
}

function readRawDashboardCards(detail: Record<string, unknown> | undefined): Record<string, unknown>[] {
  const dashcards = Array.isArray(detail?.dashcards)
    ? detail.dashcards
    : Array.isArray(detail?.ordered_cards)
      ? detail.ordered_cards
      : [];
  return dashcards.filter((dashcard): dashcard is Record<string, unknown> => typeof dashcard === "object" && dashcard !== null);
}

function toCardAsset(
  client: MetabaseClient,
  card: Record<string, unknown>,
  options: { detailLoaded: boolean }
): DataAsset {
  const id = String(getNumber(card.id) ?? getString(card.id) ?? "");
  const name = getString(card.name) ?? getString(card.title) ?? `Metabase card ${id}`;
  const datasetQuery = getObject(card.dataset_query);
  const nativeQuery = getObject(datasetQuery?.native);
  const queryText = getString(nativeQuery?.query) ?? JSON.stringify(datasetQuery ?? {}, null, 2);
  const columns = readMetabaseColumns(card);
  const collection = getObject(card.collection);
  const parameters = readMetabaseCardParameters(card);
  const dashboardId =
    getNumber(card.dashboard_id) ??
    getNumber(card.dashboardId) ??
    getNumber(getObject(card.dashboard)?.id);
  const isModel = isMetabaseModel(card);
  const assetType = isModel ? "model" : "card";
  const route = isModel ? "model" : "question";

  return {
    id: `metabase:${assetType}:${id}`,
    platform: "metabase",
    type: assetType,
    title: name,
    description: getString(card.description),
    businessDomain: getString(collection?.name),
    tags: compact(["metabase", assetType, getString(card.display), getString(collection?.name)]),
    owner: getCreatorName(card),
    url: joinUrl(client.publicUrl, `/${route}/${id}`),
    updatedAt: getString(card.updated_at) ?? getString(card.created_at),
    queryText,
    columns,
    parameters,
    sourceRefs: [
      {
        system: "metabase",
        url: joinUrl(client.publicUrl, `/${route}/${id}`)
      }
    ],
    access: buildMetabaseAccessSnapshot(card, {
      dashboardId
    }),
    warnings: compact([
      "Synced metadata only. Query execution remains read-only and row-limited.",
      options.detailLoaded
        ? undefined
        : "Metabase card detail could not be loaded; columns may come from stale list metadata."
    ])
  };
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      results[index] = await mapper(values[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return results;
}

function readMetabaseDashboardParameters(detail: Record<string, unknown> | undefined): AssetParameter[] | undefined {
  const parameters = asArray<Record<string, unknown>>(detail?.parameters);
  const mapped = parameters
    .flatMap((parameter): AssetParameter[] => {
      const id = getString(parameter.id) ?? getString(parameter.slug) ?? getString(parameter.name);
      if (!id) return [];
      return [{
        name: id,
        label: getString(parameter.name) ?? getString(parameter.label) ?? id,
        type: normalizeMetabaseParameterType(getString(parameter.type)),
        required: Boolean(parameter.required),
        defaultValue: parameter.default,
        platformTarget: parameter.target,
        raw: pickRaw(parameter, ["id", "slug", "name", "type", "target", "default"])
      }];
    });
  return mapped.length ? dedupeParameters(mapped) : undefined;
}

function readMetabaseCardParameters(card: Record<string, unknown>): AssetParameter[] | undefined {
  const explicitParameters = asArray<Record<string, unknown>>(card.parameters);
  const datasetQuery = getObject(card.dataset_query);
  const nativeQuery = getObject(datasetQuery?.native);
  const templateTags = getObject(nativeQuery?.["template-tags"]);
  const fromExplicit = explicitParameters
    .flatMap((parameter): AssetParameter[] => {
      const id = getString(parameter.id) ?? getString(parameter.slug) ?? getString(parameter.name);
      if (!id) return [];
      return [{
        name: id,
        label: getString(parameter.name) ?? getString(parameter.label) ?? id,
        type: normalizeMetabaseParameterType(getString(parameter.type)),
        required: Boolean(parameter.required),
        defaultValue: parameter.default,
        platformTarget: parameter.target,
        raw: pickRaw(parameter, ["id", "slug", "name", "type", "target", "default"])
      }];
    });
  const fromTemplateTags = Object.entries(templateTags ?? {})
    .map(([name, raw]) => {
      const tag = getObject(raw);
      return {
        name,
        label: getString(tag?.["display-name"]) ?? getString(tag?.name) ?? name,
        type: normalizeMetabaseParameterType(getString(tag?.type)),
        required: tag?.required === true,
        defaultValue: tag?.default,
        platformTarget: ["variable", ["template-tag", name]],
        raw: pickRaw(tag ?? {}, ["name", "display-name", "type", "required", "default"])
      } satisfies AssetParameter;
    });

  const merged = dedupeParameters([...fromExplicit, ...fromTemplateTags]);
  return merged.length ? merged : undefined;
}

function normalizeMetabaseParameterType(type: string | undefined): AssetParameter["type"] {
  const normalized = (type ?? "").toLowerCase();
  if (normalized.includes("date/range") || normalized.includes("daterange")) return "date_range";
  if (normalized.includes("date")) return "date";
  if (normalized.includes("number") || normalized.includes("int") || normalized.includes("float")) return "number";
  if (normalized.includes("bool")) return "boolean";
  if (normalized.includes("category") || normalized.includes("dimension") || normalized.includes("field")) return "category";
  if (normalized.includes("text") || normalized.includes("string")) return "string";
  return "unknown";
}

function dedupeParameters(parameters: AssetParameter[]): AssetParameter[] {
  const byName = new Map<string, AssetParameter>();
  for (const parameter of parameters) {
    const existing = byName.get(parameter.name);
    byName.set(parameter.name, {
      ...parameter,
      platformTarget: existing?.platformTarget ?? parameter.platformTarget,
      raw: {
        ...(parameter.raw ?? {}),
        ...(existing?.raw ?? {})
      }
    });
  }
  return Array.from(byName.values()).sort((left, right) => left.name.localeCompare(right.name));
}

function pickRaw(value: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.map((key) => [key, value[key]]).filter(([, item]) => item !== undefined));
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
      displayName: getString(column.display_name),
      type: getString(column.base_type) ?? getString(column.semantic_type) ?? "unknown",
      description: getString(column.description)
    }))
    .filter((column) => column.name);

  return columns.length ? columns : undefined;
}

function isMetabaseModel(card: Record<string, unknown> | undefined): boolean {
  return getString(card?.type)?.toLowerCase() === "model" || card?.dataset === true;
}

function getCreatorName(value: Record<string, unknown>): string | undefined {
  const creator = getObject(value.creator) ?? getObject(value.creator_common_name);
  return getString(creator?.common_name) ?? getString(creator?.email) ?? getString(value.creator_common_name);
}

function compact(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value))));
}
