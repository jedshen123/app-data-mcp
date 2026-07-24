import { randomUUID } from "node:crypto";
import { validateCardSemanticAgainstAsset } from "../cardSemantic.js";
import { validateModelSemanticAgainstAsset } from "../modelSemantic.js";
import { getAuthConfig, getMetabaseConfig } from "../config.js";
import { getMetabaseLoginUrl } from "../auth/loginRoutes.js";
import { getStoredMetabaseSession } from "../auth/metabaseSessions.js";
import { getRequestContext } from "../requestContext.js";
import type {
  AssetParameter,
  AudienceModelInput,
  AudienceOperator,
  AudienceOutput,
  ColumnMeta,
  DashboardParameterMapping,
  DataAsset,
  SemanticAggregation,
  SemanticBreakout,
  SemanticCumulative,
  SemanticFilter,
  SemanticQuery,
  CardSemanticMeasure,
  TimeDimensionMetadata
} from "../types.js";
import { fetchJson, getNumber, getObject, getString, isObject, joinUrl } from "../sync/http.js";

type MetabaseClient = {
  baseUrl: string;
  headers: HeadersInit;
};

type RunOptions = {
  params?: Record<string, unknown>;
  semantic?: SemanticQuery;
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

type AudienceRunOptions = {
  operator: AudienceOperator;
  output: AudienceOutput;
  limit: number;
};

export async function runMetabaseAsset(asset: DataAsset, options: RunOptions) {
  if (options.semantic && asset.type === "card" && asset.semantic?.role !== "metric_set") {
    throw new Error("semantic_query_not_supported: Dynamic semantic queries require a Model, Metric, or a Card governed as semantic.role=metric_set.");
  }
  if (options.semantic && !["card", "model", "metric"].includes(asset.type)) {
    throw new Error(`semantic_query_not_supported: Dynamic semantic queries are not supported for ${asset.type}.`);
  }
  const client = await createMetabaseClient();
  if (asset.type === "card" || asset.type === "model" || asset.type === "metric") {
    const cardId = getAssetNumericId(asset.id);
    const semanticQuery = options.semantic;
    if (semanticQuery && options.params && Object.keys(options.params).length > 0) {
      throw new Error("semantic_query_params_conflict: Use semantic.filters for a dynamic semantic query; params cannot be combined with semantic controls.");
    }
    const result = semanticQuery
      ? await runMetabaseSemanticQuery(client, asset, semanticQuery, options.limit)
      : await runMetabaseCard(client, cardId, asset.parameters, options);
    return {
      data: result,
      source: {
        url: asset.url,
        queryText: asset.queryText,
        sourceRefs: asset.sourceRefs ?? [],
        semanticQuery: semanticQuery ?? undefined
      },
      warnings: [
        ...(asset.warnings ?? []),
        semanticQuery
          ? `Live ${asset.type} data returned from a validated read-only semantic query.${semanticQuery.cumulative?.length ? " Running cumulative values were calculated over the complete bounded result." : ""}`
          : `Live ${asset.type} data returned from Metabase using a read-only card query endpoint.`,
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

  throw new Error(`Metabase execution is only supported for card, model, metric, and dashboard assets, got ${asset.type}.`);
}

export async function runMetabaseAudience(
  models: AudienceModelInput[],
  options: AudienceRunOptions
): Promise<NormalizedResult> {
  const client = await createMetabaseClient();
  const query = buildMetabaseAudienceQuery(models, options);
  const value = await fetchJson<unknown>(joinUrl(client.baseUrl, "/api/dataset"), {
    method: "POST",
    headers: {
      ...client.headers,
      "content-type": "application/json"
    },
    body: JSON.stringify(query)
  });
  return normalizeDatasetResponse(value, options.output === "count" ? 1 : options.limit);
}

export async function runMetabaseAudienceCsv(
  models: AudienceModelInput[],
  options: { operator: AudienceOperator; limit: number }
): Promise<{ uids: string[]; truncated: boolean; totalRowsReturned: number }> {
  const client = await createMetabaseClient();
  const query = buildMetabaseAudienceQuery(models, { ...options, output: "uids" });
  const url = joinUrl(client.baseUrl, "/api/dataset/csv?format_rows=false");
  const response = await fetch(url, {
    method: "POST",
    headers: {
      ...client.headers,
      "content-type": "application/json"
    },
    body: JSON.stringify({ query })
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status} ${response.statusText} for ${url}${body ? `: ${body.slice(0, 500)}` : ""}`);
  }
  const records = parseCsvRecords(await response.text());
  if (!records.length) throw new Error("audience_export_invalid_csv: Metabase returned an empty CSV response.");
  const dataRecords = records.slice(1).filter((record) => record.length > 1 || record[0] !== "");
  if (dataRecords.some((record) => record.length !== 1)) {
    throw new Error("audience_export_invalid_csv: expected exactly one uid column.");
  }
  return {
    uids: dataRecords.slice(0, options.limit).map((record) => record[0]),
    truncated: dataRecords.length > options.limit,
    totalRowsReturned: dataRecords.length
  };
}

export function buildMetabaseAudienceQuery(
  models: AudienceModelInput[],
  options: AudienceRunOptions
): Record<string, unknown> {
  if (models.length < 2 || models.length > 10) {
    throw new Error("audience_invalid_models: audience queries require 2-10 Models.");
  }
  if (!Number.isInteger(options.limit) || options.limit < 1) {
    throw new Error("audience_invalid_limit: limit must be a positive integer.");
  }

  const databaseIds = new Set<number>();
  const identityTypeFamilies = new Set<string>();
  const prepared = models.map(({ asset, filters }, index) => {
    if (asset.platform !== "metabase" || asset.type !== "model") {
      throw new Error(`audience_invalid_asset: ${asset.id} is not a Metabase Model.`);
    }
    if (!asset.audience || asset.audience.entityType !== "user") {
      throw new Error(`audience_uid_missing: ${asset.id} is not audience-enabled; synchronize a Model containing uid.`);
    }
    if (!Number.isInteger(asset.audience.databaseId) || asset.audience.databaseId <= 0) {
      throw new Error(`audience_database_missing: ${asset.id} has no synchronized Metabase database id.`);
    }
    if ((filters?.length ?? 0) > 20) {
      throw new Error(`audience_too_many_filters: ${asset.id} exceeds 20 filters.`);
    }
    databaseIds.add(asset.audience.databaseId);
    identityTypeFamilies.add(identityTypeFamily(asset.audience.identityType));
    const dimensions = asset.columns ?? [];
    const uidDimension = resolveDimension(asset.audience.identityField, dimensions);
    const alias = index === 0 ? undefined : `audience_${index + 1}`;
    return { asset, filters, dimensions, uidDimension, alias };
  });
  if (databaseIds.size !== 1) {
    throw new Error("audience_database_mismatch: all Models must belong to the same Metabase database.");
  }
  if (identityTypeFamilies.size !== 1) {
    throw new Error("audience_uid_type_mismatch: all uid fields must use compatible data types.");
  }

  const primaryUid = buildFieldRef(prepared[0].uidDimension);
  const joinedUids: unknown[] = [];
  const joins: Record<string, unknown>[] = [];

  for (let index = 1; index < prepared.length; index += 1) {
    const item = prepared[index];
    const joinedUid = buildFieldRef(item.uidDimension, undefined, item.alias);
    joinedUids.push(joinedUid);
    const leftUid = options.operator === "union"
      ? buildCoalesce([primaryUid, ...joinedUids.slice(0, -1)])
      : primaryUid;
    const equality = ["=", { "lib/uuid": randomUUID() }, leftUid, joinedUid];
    joins.push({
      "lib/type": "mbql/join",
      "lib/options": { "lib/uuid": randomUUID() },
      alias: item.alias,
      strategy: options.operator === "intersection" ? "inner-join" : options.operator === "difference" ? "left-join" : "full-join",
      stages: [buildAudienceLeafStage(item)],
      conditions: [equality]
    });
  }

  let resultUid: unknown = primaryUid;
  if (options.operator === "union") {
    resultUid = buildCoalesce([primaryUid, ...joinedUids]);
  }

  const stage: Record<string, unknown> = {
    "lib/type": "mbql.stage/mbql",
    joins,
    limit: options.output === "count" ? 1 : options.limit + 1
  };
  if (options.operator === "difference") {
    stage.filters = joinedUids.map((uid) => ["is-null", { "lib/uuid": randomUUID() }, uid]);
  }
  if (options.output === "count") {
    stage.aggregation = [["distinct", { "lib/uuid": randomUUID(), name: "audience_count" }, resultUid]];
  } else {
    stage.breakout = [resultUid];
  }

  return freshenMbqlUuids({
    "lib/type": "mbql/query",
    database: databaseIds.values().next().value,
    stages: [buildAudienceLeafStage(prepared[0]), stage]
  }) as Record<string, unknown>;
}

function buildAudienceLeafStage(item: {
  asset: DataAsset;
  filters?: SemanticFilter[];
  dimensions: ColumnMeta[];
  uidDimension: ColumnMeta;
}): Record<string, unknown> {
  const uid = buildFieldRef(item.uidDimension);
  return {
    "lib/type": "mbql.stage/mbql",
    "source-card": Number(getAssetNumericId(item.asset.id)),
    filters: [
      ["not-null", { "lib/uuid": randomUUID() }, uid],
      ...(item.filters ?? []).map((filter) => buildFilter(filter, item.dimensions))
    ],
    breakout: [uid]
  };
}

async function runMetabaseSemanticQuery(
  client: MetabaseClient,
  asset: DataAsset,
  semantic: SemanticQuery,
  limit: number
): Promise<NormalizedResult> {
  const query = buildMetabaseSemanticQuery(asset, semantic, limit);
  const value = await fetchJson<unknown>(joinUrl(client.baseUrl, "/api/dataset"), {
    method: "POST",
    headers: {
      ...client.headers,
      "content-type": "application/json"
    },
    body: JSON.stringify(query)
  });
  const result = normalizeDatasetResponse(value, limit);
  return asset.type === "card" && semantic.cumulative?.length
    ? applyCardCumulative(result, semantic.cumulative, asset)
    : result;
}

export function buildMetabaseSemanticQuery(asset: DataAsset, semantic: SemanticQuery, limit: number): Record<string, unknown> {
  if (asset.platform !== "metabase" || !["card", "model", "metric"].includes(asset.type)) {
    throw new Error(`semantic_query_not_supported: Expected a Metabase Model, Metric, or governed Card, got ${asset.platform}:${asset.type}.`);
  }
  if (!Number.isInteger(limit) || limit < 1) throw new Error("semantic_query_invalid_limit: limit must be a positive integer.");
  validateSemanticQueryShape(semantic);
  if (asset.type === "card") return buildMetricSetCardQuery(asset, semantic, limit);
  const availableDimensions = asset.type === "metric" ? asset.metric?.dimensions ?? [] : asset.columns ?? [];
  if (!availableDimensions.length) {
    throw new Error("semantic_metadata_missing: No synchronized dimensions are available. Run npm run sync:metabase before using semantic controls.");
  }

  if (asset.type === "metric") {
    if (semantic.fields !== undefined || semantic.aggregations !== undefined) {
      throw new Error("semantic_metric_formula_immutable: Metric formulas are governed; fields and aggregations cannot replace them. Use filters and breakouts only.");
    }
    const query = readStoredDatasetQuery(asset);
    const stages = readQueryStages(query);
    const definitionStage = [...stages].reverse().find((stage) => Array.isArray(stage.aggregation)) ?? stages.at(-1);
    if (!definitionStage) throw new Error("semantic_query_invalid_metric: Metric query has no MBQL stage.");
    appendSemanticFilters(definitionStage, semantic.filters, availableDimensions);
    if (semantic.breakouts !== undefined) {
      definitionStage.breakout = semantic.breakouts.map((breakout) => buildBreakout(breakout, availableDimensions));
    }
    // Fetch one sentinel row beyond the public response limit. Without this
    // probe, a result containing exactly `limit` rows is indistinguishable
    // from a larger result cut off by Metabase, and `truncated` is reported
    // incorrectly as false.
    definitionStage.limit = limit + 1;
    return query;
  }

  const storedQuery = readStoredDatasetQuery(asset);
  const database = getNumber(storedQuery.database);
  if (database === undefined) throw new Error("semantic_query_invalid_model: Model query does not declare a database id.");
  const stage: Record<string, unknown> = {
    "lib/type": "mbql.stage/mbql",
    "source-card": Number(getAssetNumericId(asset.id)),
    limit: limit + 1
  };
  validateModelSemanticAgainstAsset(asset);
  appendSemanticFilters(
    stage,
    mergeSemanticFilters(asset.modelSemantic?.requiredFilters, semantic.filters),
    availableDimensions
  );

  const aggregations = semantic.aggregations ?? [];
  const breakouts = semantic.breakouts ?? [];
  if (breakouts.length && !aggregations.length) {
    throw new Error("semantic_model_aggregation_required: Model breakouts require at least one aggregation.");
  }
  if (aggregations.length) {
    validateModelAggregations(asset, aggregations);
    if (semantic.fields?.length) throw new Error("semantic_model_fields_conflict: fields cannot be combined with aggregations.");
    stage.aggregation = aggregations.map((aggregation) => buildAggregation(aggregation, availableDimensions));
    if (breakouts.length) stage.breakout = breakouts.map((breakout) => buildBreakout(breakout, availableDimensions));
  } else if (semantic.fields !== undefined) {
    stage.fields = semantic.fields.map((field) => buildFieldRef(resolveDimension(field, availableDimensions)));
  }

  return {
    "lib/type": "mbql/query",
    database,
    stages: [stage]
  };
}

function validateModelAggregations(asset: DataAsset, aggregations: SemanticAggregation[]): void {
  const modelSemantic = asset.modelSemantic;
  if (!modelSemantic || modelSemantic.aggregationPolicy === "detail_only") {
    throw new Error(
      "semantic_model_aggregation_disabled: Model defaults to detail-only queries. "
      + "Configure modelSemantic.aggregationPolicy=guarded and declare governed fields before aggregating."
    );
  }
  const baseGrain = new Set((modelSemantic.baseGrain ?? []).map(normalizeFieldName));
  const entityFields = new Set((modelSemantic.entityFields ?? []).map(normalizeFieldName));
  const additiveFields = new Set((modelSemantic.additiveFields ?? []).map(normalizeFieldName));
  for (const aggregation of aggregations) {
    const field = aggregation.field ? normalizeFieldName(aggregation.field) : undefined;
    if (aggregation.operator === "count") {
      if (!baseGrain.size) {
        throw new Error("semantic_model_count_not_governed: Declare modelSemantic.baseGrain before using count.");
      }
      continue;
    }
    if (!field) throw new Error(`semantic_model_aggregation_field_required: ${aggregation.operator} requires a field.`);
    if (aggregation.operator === "distinct" && !entityFields.has(field)) {
      throw new Error(`semantic_model_distinct_not_governed: ${aggregation.field} is not declared in modelSemantic.entityFields.`);
    }
    if (aggregation.operator === "sum" && !additiveFields.has(field)) {
      throw new Error(`semantic_model_sum_not_governed: ${aggregation.field} is not declared in modelSemantic.additiveFields.`);
    }
    if (["avg", "min", "max"].includes(aggregation.operator)) {
      throw new Error(
        `semantic_model_aggregation_not_governed: ${aggregation.operator} is disabled for Model fallback; use a Metric or Card.`
      );
    }
  }
}

function mergeSemanticFilters(
  required: SemanticFilter[] | undefined,
  requested: SemanticFilter[] | undefined
): SemanticFilter[] | undefined {
  const filters = [...(required ?? []), ...(requested ?? [])];
  if (!filters.length) return undefined;
  const seen = new Set<string>();
  return filters.filter((filter) => {
    const key = JSON.stringify([normalizeFieldName(filter.field), filter.operator, filter.value]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildMetricSetCardQuery(asset: DataAsset, semantic: SemanticQuery, limit: number): Record<string, unknown> {
  if (!asset.semantic || asset.semantic.role !== "metric_set") {
    throw new Error("semantic_card_metadata_missing: Card is not governed as semantic.role=metric_set.");
  }
  if (semantic.fields !== undefined || semantic.aggregations !== undefined) {
    throw new Error("semantic_card_contract_immutable: Card metric sets use governed measures; fields and ad-hoc aggregations are not allowed.");
  }
  validateCardSemanticAgainstAsset(asset);
  const database = readAssetDatabaseId(asset);
  const dimensions = asset.semantic.dimensions.map((dimension) =>
    resolveDimension(dimension.field, asset.columns ?? [])
  );
  const selectedMeasures = resolveCardMeasures(semantic.measures, asset.semantic.measures);
  const breakouts = semantic.breakouts ?? resolveCardDefaultBreakouts(selectedMeasures, asset.semantic.defaultTimeDimension);
  const breakoutFields = breakouts.map((breakout) => resolveDimension(breakout.field, dimensions).name);
  validateCardTimeBreakouts(breakouts, selectedMeasures, asset.semantic);
  validateCardMeasureRollups(selectedMeasures, breakouts, breakoutFields, asset.semantic.baseGrain);
  validateCardCumulative(semantic.cumulative, selectedMeasures, breakoutFields, asset.semantic.measures);

  const stage: Record<string, unknown> = {
    "lib/type": "mbql.stage/mbql",
    "source-card": Number(getAssetNumericId(asset.id)),
    limit: limit + 1,
    aggregation: selectedMeasures.map((measure) =>
      buildCardMeasureAggregation(measure, asset.semantic!.measures, asset.columns ?? [])
    )
  };
  appendSemanticFilters(stage, semantic.filters, dimensions);
  if (breakouts.length) {
    stage.breakout = breakouts.map((breakout) => buildBreakout(breakout, dimensions));
  }
  return {
    "lib/type": "mbql/query",
    database,
    stages: [stage]
  };
}

function resolveCardDefaultBreakouts(
  measures: CardSemanticMeasure[],
  cardDefault: TimeDimensionMetadata | undefined
): SemanticBreakout[] {
  const candidates = measures.map((measure) => measure.timeDimension ?? cardDefault).filter(Boolean);
  if (!candidates.length) return [];
  const identities = new Set(candidates.map((candidate) =>
    `${normalizeFieldName(candidate!.field)}:${candidate!.defaultUnit ?? ""}`
  ));
  if (identities.size > 1) {
    throw new Error("semantic_measure_time_dimension_conflict: Selected measures use different default time dimensions; provide an explicit compatible breakout or query them separately.");
  }
  const selected = candidates[0]!;
  if (selected.defaultUnit && selected.supportedUnits && !selected.supportedUnits.includes(selected.defaultUnit)) {
    throw new Error(`semantic_default_time_unit_invalid: ${selected.defaultUnit} is not supported by ${selected.field}.`);
  }
  return [{ field: selected.field, unit: selected.defaultUnit }];
}

function validateCardCumulative(
  cumulative: SemanticCumulative[] | undefined,
  selectedMeasures: CardSemanticMeasure[],
  breakoutFields: string[],
  allMeasures: CardSemanticMeasure[]
): void {
  if (!cumulative?.length) return;
  const selected = new Set(selectedMeasures.map((measure) => normalizeFieldName(measure.name)));
  const breakouts = new Set(breakoutFields.map(normalizeFieldName));
  for (const item of cumulative) {
    const measure = requireCardMeasure(item.measure, allMeasures);
    if (!selected.has(normalizeFieldName(measure.name))) {
      throw new Error(`semantic_cumulative_measure_not_selected: ${item.measure} must also appear in semantic.measures.`);
    }
    if (!measure.cumulative?.supported || measure.cumulative.strategy !== "running_sum") {
      throw new Error(
        `semantic_cumulative_not_supported: ${measure.name}.`
        + (measure.cumulative?.reason ? ` ${measure.cumulative.reason}` : "")
      );
    }
    if (measure.rollup.strategy !== "sum") {
      throw new Error(`semantic_cumulative_invalid_rollup: ${measure.name} must use sum rollup for running_sum.`);
    }
    if (!breakouts.has(normalizeFieldName(item.orderBy))) {
      throw new Error(`semantic_cumulative_order_missing: ${item.orderBy} must be included in breakouts.`);
    }
    const missingPartition = item.partitionBy?.find((field) => !breakouts.has(normalizeFieldName(field)));
    if (missingPartition) {
      throw new Error(`semantic_cumulative_partition_missing: ${missingPartition} must be included in breakouts.`);
    }
  }
}

export function applyCardCumulative(
  result: NormalizedResult,
  cumulative: SemanticCumulative[],
  asset: DataAsset
): NormalizedResult {
  if (result.truncated) {
    throw new Error("semantic_cumulative_incomplete: Result exceeds the row limit; narrow filters or increase the allowed limit before calculating a cumulative value.");
  }
  const rows = [...result.rows];
  const resolved = cumulative.map((item) => {
    const measure = requireCardMeasure(item.measure, asset.semantic?.measures ?? []);
    return {
      item,
      measureKey: resolveResultColumn(measure.name, result.columns),
      orderKey: resolveResultColumn(item.orderBy, result.columns),
      partitionKeys: (item.partitionBy ?? []).map((field) => resolveResultColumn(field, result.columns)),
      alias: item.alias ?? `${measure.name}_cumulative`
    };
  });
  const sortKeys = Array.from(new Set(resolved.flatMap((item) => [...item.partitionKeys, item.orderKey])));
  rows.sort((left, right) => {
    for (const key of sortKeys) {
      const compared = compareSemanticValues(left[key], right[key]);
      if (compared !== 0) return compared;
    }
    return 0;
  });
  for (const definition of resolved) {
    const totals = new Map<string, number>();
    for (const row of rows) {
      const partition = JSON.stringify(definition.partitionKeys.map((key) => row[key] ?? null));
      const value = row[definition.measureKey];
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`semantic_cumulative_non_numeric: ${definition.measureKey} returned a non-numeric value.`);
      }
      const total = (totals.get(partition) ?? 0) + value;
      totals.set(partition, total);
      row[definition.alias] = total;
    }
  }
  return {
    ...result,
    columns: [
      ...result.columns,
      ...resolved.map((item) => ({
        name: item.alias,
        displayName: item.alias,
        type: "type/Float",
        description: `Running sum of ${item.measureKey}`
      }))
    ],
    rows
  };
}

function resolveResultColumn(requested: string, columns: ColumnMeta[]): string {
  const normalized = normalizeFieldName(requested);
  const column = columns.find((candidate) =>
    normalizeFieldName(candidate.name) === normalized || normalizeFieldName(candidate.displayName) === normalized
  );
  if (!column) throw new Error(`semantic_result_column_missing: ${requested}.`);
  return column.name;
}

function compareSemanticValues(left: unknown, right: unknown): number {
  if (left === right) return 0;
  if (left === null || left === undefined) return -1;
  if (right === null || right === undefined) return 1;
  if (typeof left === "number" && typeof right === "number") return left - right;
  const leftTime = typeof left === "string" ? Date.parse(left) : Number.NaN;
  const rightTime = typeof right === "string" ? Date.parse(right) : Number.NaN;
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) return leftTime - rightTime;
  return String(left).localeCompare(String(right));
}

function readAssetDatabaseId(asset: DataAsset): number {
  const sourceDatabase = asset.sourceRefs
    ?.find((source) => source.system === "metabase" && source.database)
    ?.database;
  if (sourceDatabase && Number.isInteger(Number(sourceDatabase))) return Number(sourceDatabase);
  try {
    const storedQuery = readStoredDatasetQuery(asset);
    const database = getNumber(storedQuery.database);
    if (database !== undefined) return database;
  } catch {
    // Native SQL Cards intentionally store readable SQL in queryText. Their
    // synchronized sourceRefs carry the database id instead.
  }
  throw new Error("semantic_card_database_missing: Card has no synchronized Metabase database id. Run npm run sync:metabase.");
}

function resolveCardMeasures(requested: string[] | undefined, measures: CardSemanticMeasure[]): CardSemanticMeasure[] {
  if (requested === undefined) {
    throw new Error("semantic_card_measures_required: metric_set Card queries must select at least one governed measure.");
  }
  if (!requested.length) throw new Error("semantic_query_empty_measures: measures must contain at least one measure when provided.");
  return requested.map((name) => {
    const normalized = normalizeFieldName(name);
    const matches = measures.filter((measure) =>
      [measure.name, measure.label, ...(measure.synonyms ?? [])]
        .some((candidate) => normalizeFieldName(candidate) === normalized)
    );
    if (!matches.length) {
      throw new Error(`semantic_measure_not_found: ${name}. Available measures: ${measures.map((measure) => measure.name).join(", ")}`);
    }
    if (matches.length > 1) throw new Error(`semantic_measure_ambiguous: ${name}. Use the exact measure name.`);
    return matches[0];
  });
}

function validateCardTimeBreakouts(
  breakouts: SemanticBreakout[],
  measures: CardSemanticMeasure[],
  semantic: NonNullable<DataAsset["semantic"]>
): void {
  for (const breakout of breakouts) {
    if (!breakout.unit) continue;
    const dimension = semantic.dimensions.find((candidate) =>
      normalizeFieldName(candidate.field) === normalizeFieldName(breakout.field)
    );
    if (dimension?.supportedUnits && !dimension.supportedUnits.includes(breakout.unit)) {
      throw new Error(`semantic_breakout_unit_not_allowed: ${breakout.field} does not support ${breakout.unit}.`);
    }
    const applicableTimeDimensions = [
      semantic.defaultTimeDimension,
      ...measures.map((measure) => measure.timeDimension)
    ].filter((candidate) =>
      candidate && normalizeFieldName(candidate.field) === normalizeFieldName(breakout.field)
    );
    for (const timeDimension of applicableTimeDimensions) {
      if (timeDimension?.supportedUnits && !timeDimension.supportedUnits.includes(breakout.unit)) {
        throw new Error(`semantic_breakout_unit_not_allowed: ${breakout.field} does not support ${breakout.unit}.`);
      }
    }
  }
}

function validateCardMeasureRollups(
  measures: CardSemanticMeasure[],
  breakouts: SemanticBreakout[],
  breakoutFields: string[],
  baseGrain: string[]
): void {
  const normalizedBreakouts = new Set(breakoutFields.map(normalizeFieldName));
  const normalizedBaseGrain = new Set(baseGrain.map(normalizeFieldName));
  const exactBaseGrain = normalizedBreakouts.size === normalizedBaseGrain.size
    && Array.from(normalizedBaseGrain).every((field) => normalizedBreakouts.has(field))
    && breakouts.every((breakout) => !breakout.unit || breakout.unit === "day");
  for (const measure of measures) {
    const rollup = measure.rollup;
    if (rollup.allowedGroupBy) {
      const allowed = new Set(rollup.allowedGroupBy.map(normalizeFieldName));
      const invalid = breakoutFields.find((field) => !allowed.has(normalizeFieldName(field)));
      if (invalid) throw new Error(`semantic_measure_group_by_not_allowed: ${measure.name} cannot group by ${invalid}.`);
    }
    if (rollup.allowedTimeUnits) {
      const invalid = breakouts.find((breakout) => breakout.unit && !rollup.allowedTimeUnits!.includes(breakout.unit));
      if (invalid) throw new Error(`semantic_measure_time_unit_not_allowed: ${measure.name} does not support ${invalid.unit}.`);
    }
    if (rollup.strategy === "forbidden" && !exactBaseGrain) {
      throw new Error(
        `semantic_measure_rollup_forbidden: ${measure.name} cannot be rolled up from base grain (${baseGrain.join(", ")}).`
        + (rollup.reason ? ` ${rollup.reason}` : "")
      );
    }
  }
}

function buildCardMeasureAggregation(
  measure: CardSemanticMeasure,
  allMeasures: CardSemanticMeasure[],
  columns: ColumnMeta[]
): unknown {
  const options = { "lib/uuid": randomUUID(), name: measure.name };
  if (measure.rollup.strategy === "recompute") {
    const formula = measure.rollup.formula;
    if (!formula) throw new Error(`semantic_measure_formula_missing: ${measure.name}.`);
    const numerator = requireCardMeasure(formula.numerator, allMeasures);
    const denominator = requireCardMeasure(formula.denominator, allMeasures);
    return [
      "/",
      options,
      buildCardBaseAggregation(numerator, columns),
      buildCardBaseAggregation(denominator, columns)
    ];
  }
  const operator = measure.rollup.strategy === "forbidden" ? "max" : measure.rollup.strategy;
  return [
    operator,
    options,
    buildFieldRef(resolveDimension(measure.sourceColumn ?? measure.name, columns))
  ];
}

function buildCardBaseAggregation(measure: CardSemanticMeasure, columns: ColumnMeta[]): unknown {
  if (!["sum", "min", "max"].includes(measure.rollup.strategy)) {
    throw new Error(`semantic_measure_formula_dependency_invalid: ${measure.name} must use sum, min, or max rollup.`);
  }
  return [
    measure.rollup.strategy,
    { "lib/uuid": randomUUID() },
    buildFieldRef(resolveDimension(measure.sourceColumn ?? measure.name, columns))
  ];
}

function requireCardMeasure(name: string, measures: CardSemanticMeasure[]): CardSemanticMeasure {
  const normalized = normalizeFieldName(name);
  const measure = measures.find((candidate) => normalizeFieldName(candidate.name) === normalized);
  if (!measure) throw new Error(`semantic_measure_formula_dependency_missing: ${name}.`);
  return measure;
}

function readStoredDatasetQuery(asset: DataAsset): Record<string, unknown> {
  if (!asset.queryText) throw new Error("semantic_query_definition_missing: Asset has no synchronized Metabase query definition.");
  try {
    const parsed = JSON.parse(asset.queryText);
    if (!isObject(parsed)) throw new Error("not an object");
    return structuredClone(parsed);
  } catch (error) {
    throw new Error(`semantic_query_definition_invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function readQueryStages(query: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(query.stages) ? query.stages.filter(isObject) : [];
}

function validateSemanticQueryShape(semantic: SemanticQuery): void {
  if (Buffer.byteLength(JSON.stringify(semantic), "utf8") > 65_536) throw new Error("semantic_query_too_large: maximum 65536 bytes.");
  if ((semantic.filters?.length ?? 0) > 20) throw new Error("semantic_query_too_many_filters: maximum 20.");
  if ((semantic.breakouts?.length ?? 0) > 5) throw new Error("semantic_query_too_many_breakouts: maximum 5.");
  if ((semantic.fields?.length ?? 0) > 50) throw new Error("semantic_query_too_many_fields: maximum 50.");
  if ((semantic.aggregations?.length ?? 0) > 10) throw new Error("semantic_query_too_many_aggregations: maximum 10.");
  if ((semantic.measures?.length ?? 0) > 20) throw new Error("semantic_query_too_many_measures: maximum 20.");
  if ((semantic.cumulative?.length ?? 0) > 10) throw new Error("semantic_query_too_many_cumulative: maximum 10.");
  if (semantic.fields !== undefined && semantic.fields.length === 0) throw new Error("semantic_query_empty_fields: fields must contain at least one field when provided.");
  if (semantic.aggregations !== undefined && semantic.aggregations.length === 0) throw new Error("semantic_query_empty_aggregations: aggregations must contain at least one aggregation when provided.");
  if (semantic.measures !== undefined && semantic.measures.length === 0) throw new Error("semantic_query_empty_measures: measures must contain at least one measure when provided.");
}

function appendSemanticFilters(
  stage: Record<string, unknown>,
  filters: SemanticFilter[] | undefined,
  dimensions: ColumnMeta[]
): void {
  if (!filters?.length) return;
  const existing = Array.isArray(stage.filters) ? stage.filters : [];
  stage.filters = [...existing, ...filters.map((filter) => buildFilter(filter, dimensions))];
}

function buildFilter(filter: SemanticFilter, dimensions: ColumnMeta[], joinAlias?: string): unknown {
  const dimension = resolveDimension(filter.field, dimensions);
  const fieldRef = buildFieldRef(dimension, undefined, joinAlias);
  const options = { "lib/uuid": randomUUID() };
  switch (filter.operator) {
    case "eq": return ["=", options, fieldRef, requireScalarValue(filter)];
    case "neq": return ["!=", options, fieldRef, requireScalarValue(filter)];
    case "gt": return [">", options, fieldRef, requireScalarValue(filter)];
    case "gte": return [">=", options, fieldRef, requireScalarValue(filter)];
    case "lt": return ["<", options, fieldRef, requireScalarValue(filter)];
    case "lte": return ["<=", options, fieldRef, requireScalarValue(filter)];
    case "contains": {
      if (typeof filter.value !== "string" || !filter.value.length) throw new Error(`semantic_filter_invalid_value: contains requires a non-empty string for ${filter.field}.`);
      return ["contains", options, fieldRef, filter.value];
    }
    case "is_null": return ["is-null", options, fieldRef];
    case "not_null": return ["not-null", options, fieldRef];
    case "in":
    case "not_in": {
      if (!Array.isArray(filter.value) || filter.value.length === 0 || filter.value.length > 100) {
        throw new Error(`semantic_filter_invalid_value: ${filter.operator} requires 1-100 values for ${filter.field}.`);
      }
      if (!filter.value.every(isSemanticScalar)) throw new Error(`semantic_filter_invalid_value: ${filter.operator} values must be scalar for ${filter.field}.`);
      return [filter.operator === "in" ? "=" : "!=", options, fieldRef, ...filter.value];
    }
    case "between": {
      if (!Array.isArray(filter.value) || filter.value.length !== 2) {
        throw new Error(`semantic_filter_invalid_value: between requires [from, to] for ${filter.field}.`);
      }
      if (!filter.value.every(isSemanticScalar)) throw new Error(`semantic_filter_invalid_value: between values must be scalar for ${filter.field}.`);
      return ["between", options, fieldRef, filter.value[0], filter.value[1]];
    }
    default: throw new Error(`semantic_filter_invalid_operator: ${String(filter.operator)}.`);
  }
}

function requireScalarValue(filter: SemanticFilter): unknown {
  if (!isSemanticScalar(filter.value)) {
    throw new Error(`semantic_filter_invalid_value: ${filter.operator} requires a scalar value for ${filter.field}.`);
  }
  return filter.value;
}

function isSemanticScalar(value: unknown): value is string | number | boolean {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value)) || typeof value === "boolean";
}

function buildBreakout(breakout: SemanticBreakout, dimensions: ColumnMeta[]): unknown {
  const dimension = resolveDimension(breakout.field, dimensions);
  if (breakout.unit && !["minute", "hour", "day", "week", "month", "quarter", "year"].includes(breakout.unit)) {
    throw new Error(`semantic_breakout_invalid_unit: ${breakout.unit}.`);
  }
  if (breakout.unit && !isTemporalDimension(dimension)) {
    throw new Error(`semantic_breakout_invalid_unit: ${breakout.field} is not a temporal field.`);
  }
  return buildFieldRef(dimension, breakout.unit);
}

function buildAggregation(aggregation: SemanticAggregation, dimensions: ColumnMeta[]): unknown {
  const options: Record<string, unknown> = { "lib/uuid": randomUUID() };
  if (aggregation.alias) options.name = aggregation.alias;
  if (aggregation.operator === "count") {
    if (aggregation.field) throw new Error("semantic_aggregation_invalid: count must not declare field; use distinct for a field count.");
    return ["count", options];
  }
  if (!aggregation.field) throw new Error(`semantic_aggregation_invalid: ${aggregation.operator} requires field.`);
  const dimension = resolveDimension(aggregation.field, dimensions);
  if (["sum", "avg"].includes(aggregation.operator) && !isNumericDimension(dimension)) {
    throw new Error(`semantic_aggregation_invalid: ${aggregation.operator} requires a numeric field, got ${aggregation.field}.`);
  }
  return [aggregation.operator, options, buildFieldRef(dimension)];
}

function resolveDimension(requested: string, dimensions: ColumnMeta[]): ColumnMeta {
  const normalized = normalizeFieldName(requested);
  const matches = dimensions.filter((dimension) =>
    normalizeFieldName(dimension.name) === normalized || normalizeFieldName(dimension.displayName) === normalized
  );
  if (matches.length === 0) {
    throw new Error(`semantic_field_not_found: ${requested}. Available fields: ${dimensions.slice(0, 50).map((dimension) => dimension.name).join(", ")}`);
  }
  if (matches.length > 1) throw new Error(`semantic_field_ambiguous: ${requested}. Use the exact field name.`);
  if (!matches[0].fieldRef) throw new Error(`semantic_field_reference_missing: ${requested}. Run npm run sync:metabase.`);
  return matches[0];
}

function buildFieldRef(dimension: ColumnMeta, temporalUnit?: string, joinAlias?: string): unknown {
  const ref = structuredClone(dimension.fieldRef);
  if (!Array.isArray(ref) || ref[0] !== "field") throw new Error(`semantic_field_reference_invalid: ${dimension.name}.`);
  const options = isObject(ref[1]) ? ref[1] : {};
  ref[1] = {
    ...options,
    "base-type": getString(options["base-type"]) ?? dimension.type,
    ...(temporalUnit ? { "temporal-unit": temporalUnit } : {}),
    ...(joinAlias ? { "join-alias": joinAlias } : {}),
    "lib/uuid": randomUUID()
  };
  return ref;
}

function buildCoalesce(expressions: unknown[]): unknown {
  if (expressions.length === 1) return expressions[0];
  return ["coalesce", { "lib/uuid": randomUUID(), name: "uid" }, ...expressions];
}

function freshenMbqlUuids(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(freshenMbqlUuids);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    key === "lib/uuid" ? randomUUID() : freshenMbqlUuids(item)
  ]));
}

function identityTypeFamily(type: string): string {
  if (/integer|float|decimal|number|bigint/i.test(type)) return "number";
  if (/text|string|varchar|char/i.test(type)) return "text";
  return type.trim().toLocaleLowerCase();
}

function parseCsvRecords(csv: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  let touched = false;
  for (let index = 0; index < csv.length; index += 1) {
    const char = csv[index];
    const next = csv[index + 1];
    if (quoted) {
      if (char === '"' && next === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      touched = true;
      continue;
    }
    if (char === '"' && field.length === 0) {
      quoted = true;
      touched = true;
    } else if (char === ",") {
      record.push(field);
      field = "";
      touched = true;
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && next === "\n") index += 1;
      record.push(field);
      records.push(record);
      record = [];
      field = "";
      touched = false;
    } else {
      field += char;
      touched = true;
    }
  }
  if (quoted) throw new Error("audience_export_invalid_csv: unterminated quoted field.");
  if (touched || field.length || record.length) {
    record.push(field);
    records.push(record);
  }
  if (records[0]?.[0]?.charCodeAt(0) === 0xfeff) records[0][0] = records[0][0].slice(1);
  return records;
}

function normalizeFieldName(value: string | undefined): string {
  return (value ?? "").trim().toLocaleLowerCase();
}

function isTemporalDimension(dimension: ColumnMeta): boolean {
  return /date|time/i.test(`${dimension.type} ${dimension.semanticType ?? ""}`);
}

function isNumericDimension(dimension: ColumnMeta): boolean {
  return /integer|float|decimal|number|bigint/i.test(dimension.type);
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
    displayName: getString(col.display_name),
    type: getString(col.base_type) ?? getString(col.semantic_type) ?? "unknown",
    semanticType: getString(col.semantic_type),
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
  if (Array.isArray(row)) {
    return row.reduce<Record<string, unknown>>((record, value, index) => {
      record[columns[index]?.name ?? `col_${index + 1}`] = value;
      return record;
    }, {});
  }
  if (isObject(row)) return row;
  return { value: row };
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
  if (!id || !/^\d+$/.test(id)) throw new Error(`Invalid asset id: ${assetId}`);
  return id;
}

function getMaxDashboardCards(): number {
  const value = Number.parseInt(process.env.DATA_MAX_DASHBOARD_CARDS ?? "20", 10);
  return Number.isFinite(value) && value > 0 ? value : 20;
}
