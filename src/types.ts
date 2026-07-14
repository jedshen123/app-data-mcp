export type DataPlatform = "metabase" | "posthog" | "local";

export type DataAssetType =
  | "dashboard"
  | "card"
  | "insight"
  | "metric"
  | "table"
  | "event";

export type ColumnMeta = {
  name: string;
  type: string;
  description?: string;
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
  access?: DataAccessSnapshot;
  warnings?: string[];
};

export type AssetCatalog = {
  version: number;
  updatedAt?: string;
  assets: DataAsset[];
};
