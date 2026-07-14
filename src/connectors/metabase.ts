import { getAuthConfig, getMetabaseConfig } from "../config.js";
import { getMetabaseLoginUrl } from "../auth/loginRoutes.js";
import { getStoredMetabaseSession } from "../auth/metabaseSessions.js";
import { getRequestContext } from "../requestContext.js";
import type { AssetParameter, ColumnMeta, DataAsset } from "../types.js";
import { fetchJson, getNumber, getObject, getString, isObject, joinUrl } from "../sync/http.js";

type MetabaseClient = {
  baseUrl: string;
  headers: HeadersInit;
};

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

export async function runMetabaseAsset(asset: DataAsset, options: RunOptions) {
  const client = await createMetabaseClient();
  if (asset.type === "card") {
    const cardId = getAssetNumericId(asset.id);
    const result = await runMetabaseCard(client, cardId, asset.parameters, options);
    return {
      data: result,
      source: {
        url: asset.url,
        queryText: asset.queryText,
        sourceRefs: asset.sourceRefs ?? []
      },
      warnings: [
        ...(asset.warnings ?? []),
        "Live data returned from Metabase using a read-only card query endpoint.",
        ...(result.truncated ? [`Result truncated to ${options.limit} rows.`] : [])
      ]
    };
  }

  if (asset.type === "dashboard") {
    const dashboardId = getAssetNumericId(asset.id);
    const result = await runMetabaseDashboard(client, dashboardId, asset.parameters, options);
    return {
      data: result,
      source: {
        url: asset.url,
        sourceRefs: asset.sourceRefs ?? []
      },
      warnings: [
        ...(asset.warnings ?? []),
        "Live dashboard data returned by running readable Metabase cards in the dashboard.",
        "Dashboard execution is capped to avoid returning too much data."
      ]
    };
  }

  throw new Error(`Metabase execution is only supported for card and dashboard assets, got ${asset.type}.`);
}

async function createMetabaseClient(): Promise<MetabaseClient> {
  const config = getMetabaseConfig();
  const requestContext = getRequestContext();

  const requestSession = requestContext.metabaseSession;
  if (config.baseUrl && requestSession) {
    return {
      baseUrl: config.baseUrl,
      headers: {
        "X-Metabase-Session": requestSession
      }
    };
  }

  const storedSession = await getStoredMetabaseSession(requestContext.user);
  if (config.baseUrl && storedSession) {
    return {
      baseUrl: config.baseUrl,
      headers: {
        "X-Metabase-Session": storedSession
      }
    };
  }

  const authConfig = getAuthConfig();
  if (authConfig.metabaseAuthMode === "user-session" || !authConfig.allowServiceFallback) {
    throw new Error(
      `reauth_required: Metabase user authorization is required. Open ${getMetabaseLoginUrl()} and then call MCP with Authorization: Bearer <personal-mcp-token>.`
    );
  }

  if (config.mode === "missing") {
    throw new Error(`Metabase config is incomplete: ${config.missing.join(", ")}`);
  }

  if (config.mode === "api-key") {
    return {
      baseUrl: config.baseUrl,
      headers: {
        "x-api-key": config.apiKey
      }
    };
  }

  const session = await fetchJson<{ id: string }>(joinUrl(config.baseUrl, "/api/session"), {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      username: config.user,
      password: config.pass
    })
  });

  return {
    baseUrl: config.baseUrl,
    headers: {
      "X-Metabase-Session": session.id
    }
  };
}

async function runMetabaseCard(
  client: MetabaseClient,
  cardId: string,
  assetParameters: AssetParameter[] | undefined,
  options: RunOptions
): Promise<NormalizedResult> {
  const body = buildMetabaseQueryBody(options.params, assetParameters);

  try {
    const value = await fetchJson<unknown>(joinUrl(client.baseUrl, `/api/card/${cardId}/query/json`), {
      method: "POST",
      headers: {
        ...client.headers,
        "content-type": "application/json"
      },
      body: JSON.stringify(body)
    });
    return normalizeJsonRows(value, options.limit);
  } catch (_jsonEndpointError) {
    const value = await fetchJson<unknown>(joinUrl(client.baseUrl, `/api/card/${cardId}/query`), {
      method: "POST",
      headers: {
        ...client.headers,
        "content-type": "application/json"
      },
      body: JSON.stringify(body)
    });
    return normalizeDatasetResponse(value, options.limit);
  }
}

async function runMetabaseDashboard(
  client: MetabaseClient,
  dashboardId: string,
  assetParameters: AssetParameter[] | undefined,
  options: RunOptions
) {
  const dashboard = await fetchJson<Record<string, unknown>>(joinUrl(client.baseUrl, `/api/dashboard/${dashboardId}`), {
    headers: client.headers
  });

  const dashcards = readDashboardCards(dashboard).slice(0, getMaxDashboardCards());
  const cards = [];

  for (const dashcard of dashcards) {
    try {
      const result = await runMetabaseCard(client, dashcard.cardId, assetParameters, options);
      cards.push({
        cardId: dashcard.cardId,
        title: dashcard.title,
        data: result,
        error: null
      });
    } catch (error) {
      cards.push({
        cardId: dashcard.cardId,
        title: dashcard.title,
        data: null,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return {
    dashboardId,
    title: getString(dashboard.name) ?? `Metabase dashboard ${dashboardId}`,
    cardCount: cards.length,
    maxCardsApplied: getMaxDashboardCards(),
    cards
  };
}

function buildMetabaseQueryBody(params?: Record<string, unknown>, assetParameters: AssetParameter[] = []) {
  if (!params) return {};

  const parameters = Array.isArray(params.parameters)
    ? params.parameters
    : buildNamedMetabaseParameters(params, assetParameters);
  return parameters.length ? { parameters } : {};
}

function buildNamedMetabaseParameters(params: Record<string, unknown>, assetParameters: AssetParameter[]) {
  const reservedKeys = new Set(["parameters"]);
  return Object.entries(params)
    .filter(([name, value]) => !reservedKeys.has(name) && value !== undefined && value !== null && value !== "")
    .map(([name, value]) => {
      const definition = assetParameters.find((parameter) => parameter.name === name);
      const type = metabaseParameterType(definition, value);
      return {
        type,
        target: definition?.platformTarget ?? ["variable", ["template-tag", name]],
        value: normalizeMetabaseParameterValue(value, type)
      };
    });
}

function metabaseParameterType(parameter: AssetParameter | undefined, value: unknown): string {
  if (parameter?.raw && typeof parameter.raw.type === "string") return parameter.raw.type;
  if (parameter?.type === "date_range") return "date/range";
  if (parameter?.type === "date") return "date/single";
  if (parameter?.type === "number") return "number/=";
  if (parameter?.type === "boolean") return "category";
  if (Array.isArray(value)) return "category";
  return "category";
}

function normalizeMetabaseParameterValue(value: unknown, type: string): unknown {
  if (type === "date/range" && isObject(value)) {
    const start = getString(value.from) ?? getString(value.start) ?? getString(value.date_from);
    const end = getString(value.to) ?? getString(value.end) ?? getString(value.date_to);
    if (start && end) return `${start}~${end}`;
  }
  return value;
}

function normalizeJsonRows(value: unknown, limit: number): NormalizedResult {
  const rawRows = Array.isArray(value) ? value : [];
  const rows = rawRows.filter(isObject).slice(0, limit);
  const columns = inferColumns(rows);
  return {
    columns,
    rows,
    totalRowsReturned: rawRows.length,
    limitApplied: limit,
    truncated: rawRows.length > rows.length,
    rawShape: "json_rows"
  };
}

function normalizeDatasetResponse(value: unknown, limit: number): NormalizedResult {
  const data = getObject(getObject(value)?.data) ?? getObject(value);
  const cols = Array.isArray(data?.cols) ? data.cols.filter(isObject) : [];
  const rawRows = Array.isArray(data?.rows) ? data.rows : [];
  const columns = cols.map((col, index) => ({
    name: getString(col.name) ?? getString(col.display_name) ?? `col_${index + 1}`,
    type: getString(col.base_type) ?? getString(col.semantic_type) ?? "unknown",
    description: getString(col.description) ?? getString(col.display_name)
  }));

  const rows = rawRows.slice(0, limit).map((row) => rowToObject(row, columns));
  return {
    columns: columns.length ? columns : inferColumns(rows),
    rows,
    totalRowsReturned: rawRows.length,
    limitApplied: limit,
    truncated: rawRows.length > rows.length,
    rawShape: "dataset"
  };
}

function rowToObject(row: unknown, columns: ColumnMeta[]): Record<string, unknown> {
  if (isObject(row)) return row;
  if (!Array.isArray(row)) return { value: row };

  return row.reduce<Record<string, unknown>>((record, value, index) => {
    record[columns[index]?.name ?? `col_${index + 1}`] = value;
    return record;
  }, {});
}

function inferColumns(rows: Record<string, unknown>[]): ColumnMeta[] {
  const names = Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
  return names.map((name) => ({
    name,
    type: inferType(rows.find((row) => row[name] !== null && row[name] !== undefined)?.[name])
  }));
}

function inferType(value: unknown): string {
  if (value === null || value === undefined) return "unknown";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function readDashboardCards(dashboard: Record<string, unknown>) {
  const dashcards = Array.isArray(dashboard.dashcards)
    ? dashboard.dashcards
    : Array.isArray(dashboard.ordered_cards)
      ? dashboard.ordered_cards
      : [];

  return dashcards.filter(isObject).flatMap((dashcard) => {
    const card = getObject(dashcard.card);
    const cardId = getNumber(dashcard.card_id) ?? getNumber(card?.id);
    if (cardId === undefined) return [];
    return [
      {
        cardId: String(cardId),
        title: getString(card?.name) ?? getString(dashcard.title) ?? `Metabase card ${cardId}`
      }
    ];
  });
}

function getAssetNumericId(assetId: string): string {
  const id = assetId.split(":").at(-1);
  if (!id) throw new Error(`Invalid asset id: ${assetId}`);
  return id;
}

function getMaxDashboardCards(): number {
  const value = Number.parseInt(process.env.DATA_MAX_DASHBOARD_CARDS ?? "20", 10);
  return Number.isFinite(value) && value > 0 ? value : 20;
}
