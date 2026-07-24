export type DataPlatform = "metabase" | "posthog" | "local";

export type DataAssetType =
  | "dashboard"
  | "card"
  | "model"
  | "insight"
  | "metric"
  | "table"
  | "event";

export type ColumnMeta = {
  name: string;
  displayName?: string;
  type: string;
  semanticType?: string;
  description?: string;
  fieldRef?: unknown;
};

export type SemanticFilterOperator =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "in"
  | "not_in"
  | "contains"
  | "is_null"
  | "not_null"
  | "between";

export type SemanticFilter = {
  field: string;
  operator: SemanticFilterOperator;
  value?: unknown;
};

export type SemanticBreakout = {
  field: string;
  unit?: "minute" | "hour" | "day" | "week" | "month" | "quarter" | "year";
};

export type SemanticAggregation = {
  operator: "count" | "distinct" | "sum" | "avg" | "min" | "max";
  field?: string;
  alias?: string;
};

export type SemanticQuery = {
  filters?: SemanticFilter[];
  breakouts?: SemanticBreakout[];
  fields?: string[];
  aggregations?: SemanticAggregation[];
  measures?: string[];
  cumulative?: SemanticCumulative[];
};

export type SemanticCumulative = {
  measure: string;
  orderBy: string;
  partitionBy?: string[];
  alias?: string;
};

export type SemanticTimeUnit = "minute" | "hour" | "day" | "week" | "month" | "quarter" | "year";

export type TimeDimensionMetadata = {
  field: string;
  label?: string;
  defaultUnit?: SemanticTimeUnit;
  supportedUnits?: SemanticTimeUnit[];
  timezone?: string;
  dateMeaning?: string;
};

export type CardSemanticDimension = {
  field: string;
  label?: string;
  description?: string;
  synonyms?: string[];
  supportedUnits?: SemanticTimeUnit[];
};

export type CardMeasureFormula = {
  operator: "divide";
  numerator: string;
  denominator: string;
  zeroDivision?: "null";
  scale?: number;
};

export type CardMeasureRollup = {
  strategy: "sum" | "min" | "max" | "recompute" | "forbidden";
  allowedGroupBy?: string[];
  allowedTimeUnits?: SemanticTimeUnit[];
  formula?: CardMeasureFormula;
  reason?: string;
};

export type CardMeasureCumulative = {
  supported: boolean;
  strategy?: "running_sum" | "precomputed";
  reason?: string;
  alternativeAssetId?: string;
};

export type CardSemanticMeasure = {
  name: string;
  label?: string;
  sourceColumn?: string;
  description?: string;
  valueType?: string;
  unit?: string;
  synonyms?: string[];
  timeDimension?: TimeDimensionMetadata;
  rollup: CardMeasureRollup;
  cumulative?: CardMeasureCumulative;
};

export type CardSemanticMetadata = {
  role: "metric_set";
  baseGrain: string[];
  defaultTimeDimension?: TimeDimensionMetadata;
  dimensions: CardSemanticDimension[];
  measures: CardSemanticMeasure[];
  execution?: {
    mode: "precomputed" | "cached" | "live_query" | "unknown";
    freshness?: {
      updateFrequency?: string;
      maxDelayHours?: number;
      dataThrough?: string;
    };
    cost?: {
      tier?: "low" | "medium" | "high";
      expectedP95Ms?: number;
    };
  };
};

export type ModelSemanticMetadata = {
  role: "detail_dataset";
  aggregationPolicy: "detail_only" | "guarded";
  baseGrain?: string[];
  primaryTimeField?: string;
  entityFields?: string[];
  additiveFields?: string[];
  requiredFilters?: SemanticFilter[];
};

export type SourceRef = {
  system: string;
  database?: string;
  schema?: string;
  table?: string;
  fields?: string[];
  events?: string[];
  assetId?: string;
  url?: string;
};

export type SampleData = {
  columns: ColumnMeta[];
  rows: Record<string, unknown>[];
};

export type AssetParameter = {
  name: string;
  label?: string;
  type: "date" | "date_range" | "category" | "number" | "string" | "boolean" | "unknown";
  required?: boolean;
  defaultValue?: unknown;
  allowedValues?: string[];
  description?: string;
  platformTarget?: unknown;
  raw?: Record<string, unknown>;
};

export type DashboardParameterMapping = {
  parameterId: string;
  parameterName?: string;
  cardId: string;
  dashcardId?: string;
  cardTitle?: string;
  target?: unknown;
  parameterType?: string;
  raw?: Record<string, unknown>;
};

export type MetricDataSource = {
  kind: "table" | "card" | "model" | "metric" | "unknown";
  id: string;
  assetId?: string;
  title?: string;
};

export type MetricDefaultTimeDimension = {
  field?: unknown;
  name?: string;
  displayName?: string;
  unit?: string;
};

export type MetricMetadata = {
  formula?: unknown;
  filters?: unknown[];
  dataSource?: MetricDataSource;
  defaultTimeDimension?: MetricDefaultTimeDimension;
  dimensions?: ColumnMeta[];
  upstreamAssets?: string[];
  downstreamAssets?: string[];
  queryDescription?: string;
};

export type AudienceMetadata = {
  entityType: "user";
  identityField: string;
  identityType: string;
  databaseId: number;
};

export type AudienceOperator = "intersection" | "union" | "difference";

export type AudienceOutput = "count" | "uids";

export type AudienceModelInput = {
  asset: DataAsset;
  filters?: SemanticFilter[];
};

export type DataAccessSnapshot = {
  source: "metabase-sync" | "posthog-sync" | "local-config";
  syncedAt: string;
  visibility: "unknown" | "collection" | "personal" | "archived" | "public";
  collectionId?: number;
  collectionName?: string;
  collectionPersonalOwnerId?: number;
  collectionPersonalOwnerEmail?: string;
  dashboardId?: number;
  creatorId?: number;
  creatorEmail?: string;
  archived?: boolean;
  permissionStaleAfterHours?: number;
  raw?: Record<string, unknown>;
};

export type DataAsset = {
  id: string;
  platform: DataPlatform;
  type: DataAssetType;
  analysisType?: string;
  title: string;
  description?: string;
  businessDomain?: string;
  tags: string[];
  owner?: string;
  url: string;
  updatedAt?: string;
  popularity?: number;
  children?: string[];
  queryText?: string;
  columns?: ColumnMeta[];
  sourceRefs?: SourceRef[];
  sampleData?: SampleData;
  parameters?: AssetParameter[];
  dashboardParameterMappings?: DashboardParameterMapping[];
  metric?: MetricMetadata;
  semantic?: CardSemanticMetadata;
  modelSemantic?: ModelSemanticMetadata;
  audience?: AudienceMetadata;
  access?: DataAccessSnapshot;
  warnings?: string[];
};

export type AssetCatalog = {
  version: number;
  updatedAt?: string;
  assets: DataAsset[];
};
