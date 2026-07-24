import { z } from "zod";
import type { CardSemanticMetadata, DataAsset } from "./types.js";

const timeUnitSchema = z.enum(["minute", "hour", "day", "week", "month", "quarter", "year"]);

const timeDimensionSchema = z.object({
  field: z.string().min(1),
  label: z.string().min(1).optional(),
  defaultUnit: timeUnitSchema.optional(),
  supportedUnits: z.array(timeUnitSchema).min(1).max(7).optional(),
  timezone: z.string().min(1).optional(),
  dateMeaning: z.string().min(1).optional()
}).strict();

const semanticDimensionSchema = z.object({
  field: z.string().min(1),
  label: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  synonyms: z.array(z.string().min(1)).max(50).optional(),
  supportedUnits: z.array(timeUnitSchema).min(1).max(7).optional()
}).strict();

const rollupSchema = z.object({
  strategy: z.enum(["sum", "min", "max", "recompute", "forbidden"]),
  allowedGroupBy: z.array(z.string().min(1)).max(20).optional(),
  allowedTimeUnits: z.array(timeUnitSchema).min(1).max(7).optional(),
  formula: z.object({
    operator: z.literal("divide"),
    numerator: z.string().min(1),
    denominator: z.string().min(1),
    zeroDivision: z.literal("null").optional(),
    scale: z.number().int().min(0).max(12).optional()
  }).strict().optional(),
  reason: z.string().min(1).optional()
}).strict().superRefine((rollup, context) => {
  if (rollup.strategy === "recompute" && !rollup.formula) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "recompute rollup requires formula" });
  }
  if (rollup.strategy !== "recompute" && rollup.formula) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "formula is only valid for recompute rollup" });
  }
});

const semanticMeasureSchema = z.object({
  name: z.string().min(1),
  label: z.string().min(1).optional(),
  sourceColumn: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  valueType: z.string().min(1).optional(),
  unit: z.string().min(1).optional(),
  synonyms: z.array(z.string().min(1)).max(50).optional(),
  timeDimension: timeDimensionSchema.optional(),
  rollup: rollupSchema,
  cumulative: z.object({
    supported: z.boolean(),
    strategy: z.enum(["running_sum", "precomputed"]).optional(),
    reason: z.string().min(1).optional(),
    alternativeAssetId: z.string().min(1).optional()
  }).strict().optional()
}).strict();

export const cardSemanticMetadataSchema = z.object({
  role: z.literal("metric_set"),
  baseGrain: z.array(z.string().min(1)).max(20),
  defaultTimeDimension: timeDimensionSchema.optional(),
  dimensions: z.array(semanticDimensionSchema).max(50),
  measures: z.array(semanticMeasureSchema).min(1).max(50)
  ,
  execution: z.object({
    mode: z.enum(["precomputed", "cached", "live_query", "unknown"]),
    freshness: z.object({
      updateFrequency: z.string().min(1).optional(),
      maxDelayHours: z.number().nonnegative().optional(),
      dataThrough: z.string().min(1).optional()
    }).strict().optional(),
    cost: z.object({
      tier: z.enum(["low", "medium", "high"]).optional(),
      expectedP95Ms: z.number().int().positive().optional()
    }).strict().optional()
  }).strict().optional()
}).strict().superRefine((semantic, context) => {
  checkUnique(semantic.baseGrain, "baseGrain", context);
  checkUnique(semantic.dimensions.map((dimension) => dimension.field), "dimensions", context);
  checkUnique(semantic.measures.map((measure) => measure.name), "measures", context);
  const dimensionNames = new Set(semantic.dimensions.map((dimension) => normalize(dimension.field)));
  const measureNames = new Set(semantic.measures.map((measure) => normalize(measure.name)));
  const requireDimension = (field: string, path: Array<string | number>) => {
    if (!dimensionNames.has(normalize(field))) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `unknown semantic dimension: ${field}`, path });
    }
  };
  semantic.baseGrain.forEach((field, index) => requireDimension(field, ["baseGrain", index]));
  if (semantic.defaultTimeDimension) requireDimension(semantic.defaultTimeDimension.field, ["defaultTimeDimension", "field"]);
  semantic.measures.forEach((measure, index) => {
    if (measure.timeDimension) requireDimension(measure.timeDimension.field, ["measures", index, "timeDimension", "field"]);
    measure.rollup.allowedGroupBy?.forEach((field, fieldIndex) =>
      requireDimension(field, ["measures", index, "rollup", "allowedGroupBy", fieldIndex])
    );
    const formula = measure.rollup.formula;
    if (formula) {
      if (normalize(formula.numerator) === normalize(measure.name) || normalize(formula.denominator) === normalize(measure.name)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `formula cannot reference itself: ${measure.name}`,
          path: ["measures", index, "rollup", "formula"]
        });
      }
      for (const [key, value] of [["numerator", formula.numerator], ["denominator", formula.denominator]] as const) {
        if (!measureNames.has(normalize(value))) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: `unknown formula measure: ${value}`,
            path: ["measures", index, "rollup", "formula", key]
          });
        }
      }
      for (const dependencyName of [formula.numerator, formula.denominator]) {
        const dependency = semantic.measures.find((candidate) => normalize(candidate.name) === normalize(dependencyName));
        if (dependency && !["sum", "min", "max"].includes(dependency.rollup.strategy)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: `formula dependency must use sum, min, or max rollup: ${dependencyName}`,
            path: ["measures", index, "rollup", "formula"]
          });
        }
      }
    }
  });
});

export function parseCardSemanticMetadata(value: unknown): CardSemanticMetadata {
  return cardSemanticMetadataSchema.parse(value);
}

export function validateCardSemanticAgainstAsset(asset: DataAsset): void {
  const semantic = asset.semantic;
  if (!semantic) return;
  if (asset.platform !== "metabase" || asset.type !== "card") {
    throw new Error("card_semantic_invalid_asset: metric_set semantic metadata is only supported on Metabase Cards.");
  }
  const columns = asset.columns ?? [];
  const names = new Set(columns.flatMap((column) => [normalize(column.name), normalize(column.displayName)]));
  const requireColumn = (field: string, kind: string) => {
    if (!names.has(normalize(field))) {
      throw new Error(`card_semantic_column_not_found: ${kind} ${field}. Synchronize the Card and use an output column name.`);
    }
  };
  semantic.dimensions.forEach((dimension) => requireColumn(dimension.field, "dimension"));
  semantic.measures.forEach((measure) => {
    const field = measure.sourceColumn ?? measure.name;
    if (measure.rollup.strategy !== "recompute" || measure.sourceColumn) requireColumn(field, "measure");
    const column = columns.find((candidate) =>
      normalize(candidate.name) === normalize(field) || normalize(candidate.displayName) === normalize(field)
    );
    if (measure.rollup.strategy === "sum" && column && !isNumericType(column.type)) {
      throw new Error(`card_semantic_measure_not_numeric: ${measure.name} uses sum but ${field} is ${column.type}.`);
    }
    if (measure.cumulative?.supported && measure.cumulative.strategy === "running_sum" && measure.rollup.strategy !== "sum") {
      throw new Error(`card_semantic_cumulative_invalid: ${measure.name} must use sum rollup for running_sum.`);
    }
  });
  const defaultTime = semantic.defaultTimeDimension;
  if (defaultTime?.defaultUnit) {
    const column = columns.find((candidate) =>
      normalize(candidate.name) === normalize(defaultTime.field) || normalize(candidate.displayName) === normalize(defaultTime.field)
    );
    if (column && !isTemporalType(column.type)) {
      throw new Error(`card_semantic_time_dimension_invalid: ${defaultTime.field} is ${column.type}, not a temporal field.`);
    }
  }
}

function checkUnique(values: string[], label: string, context: z.RefinementCtx): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    const key = normalize(value);
    if (seen.has(key)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate ${label} value: ${value}`, path: [label, index] });
    }
    seen.add(key);
  });
}

function normalize(value: string | undefined): string {
  return (value ?? "").trim().toLocaleLowerCase();
}

function isNumericType(type: string): boolean {
  return /(integer|float|decimal|number|bigint)/i.test(type);
}

function isTemporalType(type: string): boolean {
  return /(date|time)/i.test(type);
}
