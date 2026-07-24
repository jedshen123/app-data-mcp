import { z } from "zod";
import type { DataAsset, ModelSemanticMetadata } from "./types.js";

const filterSchema = z.object({
  field: z.string().min(1),
  operator: z.enum(["eq", "neq", "gt", "gte", "lt", "lte", "in", "not_in", "contains", "is_null", "not_null", "between"]),
  value: z.unknown().optional()
}).strict();

export const modelSemanticMetadataSchema = z.object({
  role: z.literal("detail_dataset"),
  aggregationPolicy: z.enum(["detail_only", "guarded"]).default("detail_only"),
  baseGrain: z.array(z.string().min(1)).max(20).optional(),
  primaryTimeField: z.string().min(1).optional(),
  entityFields: z.array(z.string().min(1)).max(50).optional(),
  additiveFields: z.array(z.string().min(1)).max(50).optional(),
  requiredFilters: z.array(filterSchema).max(20).optional()
}).strict().superRefine((semantic, context) => {
  for (const [key, values] of [
    ["baseGrain", semantic.baseGrain],
    ["entityFields", semantic.entityFields],
    ["additiveFields", semantic.additiveFields]
  ] as const) {
    const seen = new Set<string>();
    values?.forEach((value, index) => {
      const normalized = normalize(value);
      if (seen.has(normalized)) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate ${key} value: ${value}`, path: [key, index] });
      }
      seen.add(normalized);
    });
  }
});

export function parseModelSemanticMetadata(value: unknown): ModelSemanticMetadata {
  return modelSemanticMetadataSchema.parse(value);
}

export function validateModelSemanticAgainstAsset(asset: DataAsset): void {
  const semantic = asset.modelSemantic;
  if (!semantic) return;
  if (asset.platform !== "metabase" || asset.type !== "model") {
    throw new Error("model_semantic_invalid_asset: detail_dataset semantic metadata is only supported on Metabase Models.");
  }
  const columns = new Set((asset.columns ?? []).flatMap((column) => [normalize(column.name), normalize(column.displayName)]));
  const requireColumn = (field: string, kind: string) => {
    if (!columns.has(normalize(field))) {
      throw new Error(`model_semantic_column_not_found: ${kind} ${field}. Synchronize the Model and use an output column name.`);
    }
  };
  semantic.baseGrain?.forEach((field) => requireColumn(field, "baseGrain"));
  semantic.entityFields?.forEach((field) => requireColumn(field, "entityField"));
  semantic.additiveFields?.forEach((field) => requireColumn(field, "additiveField"));
  if (semantic.primaryTimeField) requireColumn(semantic.primaryTimeField, "primaryTimeField");
  semantic.requiredFilters?.forEach((filter) => requireColumn(filter.field, "requiredFilter"));
}

function normalize(value: string | undefined): string {
  return (value ?? "").trim().toLocaleLowerCase();
}
