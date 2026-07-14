import { getAuthConfig, getMetabaseConfig } from "../config.js";
import { getMetabaseLoginUrl } from "../auth/loginRoutes.js";
import { getStoredMetabaseSession } from "../auth/metabaseSessions.js";
import { getRequestContext } from "../requestContext.js";
import type { AssetParameter, ColumnMeta, DashboardParameterMapping, DataAsset } from "../types.js";
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
    const result = await runMetabaseDashboard(client, dashboardId, asset, options);
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
  asset: DataAsset,
  options: RunOptions
) {
  const dashboard = await fetchJson<Record<string, unknown>>(joinUrl(client.baseUrl, `/api/dashboard/${dashboardId}`), {
    headers: client.headers
  });

  const dashboardParameters = readDashboardParameters(dashboard, asset.parameters);
  const dashcards = readDashboardCards(dashboard)
    .slice(0, getMaxDashboardCards())
    .map((dashcard) => ({
      ...dashcard,
      parameterMappings: dashcard.parameterMappings.length
        ? dashcard.parameterMappings
        : (asset.dashboardParameterMappings ?? []).filter((mapping) => mapping.cardId === dashcard.cardId)
    }));
  const cards = [];

  for (const dashcard of dashcards) {
    const parameterPlan = buildDashboardCardParameterPlan(options.params, dashboardParameters, dashcard.parameterMappings);

    try {
      const result = await runMetabaseCard(client, dashcard.cardId, undefined, {
        ...options,
        params: parameterPlan.params
      });
      cards.push({
        cardId: dashcard.cardId,
        title: dashcard.title,
        parameterMappingStatus: parameterPlan.status,
        data: result,
        error: null
      });
    } catch (error) {
      cards.push({
        cardId: dashcard.cardId,
        title: dashcard.title,
        parameterMappingStatus: parameterPlan.status,
        data: null,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return {
    dashboardId,
    title: getString(dashboard.name) ?? `Metabase dashboard ${dashboardId}`,
    requestedParameters: getRequestedParameterNames(options.params),
    parameterCoverage: buildDashboardParameterCoverage(options.params, dashcards),
    cardCount: cards.length,
    maxCardsApplied: getMaxDashboardCards(),
    cards
  };
}

function buildDashboardCardParameterPlan(
  params: Record<string, unknown> | undefined,
  dashboardParameters: AssetParameter[],
  mappings: DashboardParameterMapping[]
) {
  if (!params || Object.keys(params).length === 0) {
    return {
      params: undefined,
      status: {
        status: "no_params",
        requestedParameters: [],
        appliedParameters: [],
        unmappedParameters: [],
        mappedParametersAvailable: mappings.map((mapping) => mapping.parameterId)
      }
    };
  }

  if (Array.isArray(params.parameters)) {
    return {
      params,
      status: {
        status: "native_parameters",
        requestedParameters: ["parameters"],
        appliedParameters: ["parameters"],
        unmappedParameters: [],
        mappedParametersAvailable: mappings.map((mapping) => mapping.parameterId),
        note: "Native Metabase params.parameters were passed through; friendly dashboard mapping coverage cannot be inferred."
      }
    };
  }

  const requestedParameters = getRequestedParameterNames(params);
  const mappingByParameter = new Map(mappings.map((mapping) => [mapping.parameterId, mapping]));
  const metabaseParameters = [];
  const appliedParameters = [];
  const unmappedParameters = [];

  for (const name of requestedParameters) {
    const value = params[name];
    const mapping = mappingByParameter.get(name);
    if (!mapping?.target) {
      unmappedParameters.push(name);
      continue;
    }

    const definition = dashboardParameters.find((parameter) => parameter.name === name);
    const type = mapping.parameterType ?? metabaseParameterType(definition, value);
    metabaseParameters.push({
      type,
      target: mapping.target,
      value: normalizeMetabaseParameterValue(value, type)
    });
    appliedParameters.push(name);
  }

  return {
    params: metabaseParameters.length ? { parameters: metabaseParameters } : undefined,
    status: {
      status:
        appliedParameters.length === 0
          ? "unmapped"
          : unmappedParameters.length
            ? "partially_mapped"
            : "mapped",
      requestedParameters,
      appliedParameters,
      unmappedParameters,
      mappedParametersAvailable: mappings.map((mapping) => mapping.parameterId)
    }
  };
}

function buildDashboardParameterCoverage(
  params: Record<string, unknown> | undefined,
  dashcards: ReturnType<typeof readDashboardCards>
) {
  const requestedParameters = getRequestedParameterNames(params);
  if (!requestedParameters.length) return [];

  return requestedParameters.map((parameter) => {
    const mappedCards = dashcards.filter((dashcard) =>
      dashcard.parameterMappings.some((mapping) => mapping.parameterId === parameter)
    );
    return {
      parameter,
      mappedCardCount: mappedCards.length,
      mappedCards: mappedCards.map((dashcard) => ({
        cardId: dashcard.cardId,
        title: dashcard.title
      }))
    };
  });
}

function getRequestedParameterNames(params: Record<string, unknown> | undefined): string[] {
  if (!params || Array.isArray(params.parameters)) return [];
  return Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([name]) => name);
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
    const dashcardId = getNumber(dashcard.id) ?? getNumber(dashcard.dashboard_card_id);
    const title = getString(card?.name) ?? getString(dashcard.title) ?? `Metabase card ${cardId}`;
    return [
      {
        cardId: String(cardId),
        dashcardId: dashcardId === undefined ? undefined : String(dashcardId),
        title,
        parameterMappings: readDashcardParameterMappings(dashcard, String(cardId), title)
      }
    ];
  });
}

function readDashboardParameters(
  dashboard: Record<string, unknown>,
  fallbackParameters: AssetParameter[] | undefined
): AssetParameter[] {
  const parameters = Array.isArray(dashboard.parameters) ? dashboard.parameters.filter(isObject) : [];
  const parsed = parameters.flatMap((parameter): AssetParameter[] => {
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
  return parsed.length ? dedupeParameters(parsed) : fallbackParameters ?? [];
}

function readDashcardParameterMappings(
  dashcard: Record<string, unknown>,
  cardId: string,
  cardTitle: string
): DashboardParameterMapping[] {
  const dashcardId = getNumber(dashcard.id) ?? getNumber(dashcard.dashboard_card_id);
  const mappings = Array.isArray(dashcard.parameter_mappings)
    ? dashcard.parameter_mappings.filter(isObject)
    : [];

  return mappings.flatMap((mapping): DashboardParameterMapping[] => {
    const parameterId =
      getString(mapping.parameter_id) ??
      getString(mapping.parameterId) ??
      getString(getObject(mapping.parameter)?.id);
    if (!parameterId) return [];
    return [{
      parameterId,
      cardId,
      dashcardId: dashcardId === undefined ? undefined : String(dashcardId),
      cardTitle,
      target: mapping.target,
      parameterType: getString(mapping.parameter_type) ?? getString(mapping.parameterType),
      raw: pickRaw(mapping, ["parameter_id", "card_id", "target", "parameter_type"])
    }];
  });
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

function getAssetNumericId(assetId: string): string {
  const id = assetId.split(":").at(-1);
  if (!id) throw new Error(`Invalid asset id: ${assetId}`);
  return id;
}

function getMaxDashboardCards(): number {
  const value = Number.parseInt(process.env.DATA_MAX_DASHBOARD_CARDS ?? "20", 10);
  return Number.isFinite(value) && value > 0 ? value : 20;
}
