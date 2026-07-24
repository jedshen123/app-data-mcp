import type { DataAsset } from "./types.js";

export function summarizeAsset(asset: DataAsset) {
  return {
    id: asset.id,
    platform: asset.platform,
    type: asset.type,
    title: asset.title,
    description: asset.description,
    businessDomain: asset.businessDomain,
    tags: asset.tags,
    owner: asset.owner,
    url: asset.url,
    updatedAt: asset.updatedAt,
    popularity: asset.popularity,
    parameters: asset.parameters?.map((parameter) => ({
      name: parameter.name,
      label: parameter.label,
      type: parameter.type,
      required: parameter.required,
      description: parameter.description
    })),
    dashboardParameterMappings: asset.dashboardParameterMappings
      ? {
          count: asset.dashboardParameterMappings.length,
          byParameter: summarizeDashboardParameterMappings(asset)
        }
      : undefined,
    metric: asset.metric ? {
      formula: asset.metric.formula,
      filters: asset.metric.filters,
      dataSource: asset.metric.dataSource,
      defaultTimeDimension: asset.metric.defaultTimeDimension,
      dimensionCount: asset.metric.dimensions?.length ?? 0,
      dimensions: asset.metric.dimensions?.slice(0, 20).map((dimension) => ({
        name: dimension.name,
        displayName: dimension.displayName,
        type: dimension.type,
        description: dimension.description
      })),
      dimensionsTruncated: (asset.metric.dimensions?.length ?? 0) > 20,
      upstreamAssets: asset.metric.upstreamAssets,
      downstreamAssets: asset.metric.downstreamAssets,
      queryDescription: asset.metric.queryDescription
    } : undefined,
    semantic: asset.semantic ? {
      role: asset.semantic.role,
      baseGrain: asset.semantic.baseGrain,
      execution: asset.semantic.execution,
      defaultTimeDimension: asset.semantic.defaultTimeDimension,
      dimensions: asset.semantic.dimensions,
      measures: asset.semantic.measures.map((measure) => ({
        name: measure.name,
        sourceColumn: measure.sourceColumn,
        label: measure.label,
        description: measure.description,
        unit: measure.unit,
        synonyms: measure.synonyms,
        timeDimension: measure.timeDimension,
        rollup: measure.rollup,
        cumulative: measure.cumulative
      }))
    } : undefined,
    modelSemantic: asset.modelSemantic,
    audience: asset.audience,
    access: asset.access
      ? {
          visibility: asset.access.visibility,
          collectionId: asset.access.collectionId,
          collectionName: asset.access.collectionName,
          syncedAt: asset.access.syncedAt,
          staleAfterHours: asset.access.permissionStaleAfterHours
        }
      : undefined,
    warnings: asset.warnings
  };
}

export function summarizeSemanticMatches(asset: DataAsset, query: string) {
  const tokens = normalizeSearchTokens(query);
  if (!asset.semantic || !tokens.length) return undefined;
  const matches = [
    ...asset.semantic.dimensions.map((dimension) => ({
      kind: "dimension" as const,
      name: dimension.field,
      label: dimension.label,
      text: [dimension.field, dimension.label, dimension.description, ...(dimension.synonyms ?? [])].filter(Boolean).join(" ")
    })),
    ...asset.semantic.measures.map((measure) => ({
      kind: "measure" as const,
      name: measure.name,
      label: measure.label,
      text: [measure.name, measure.sourceColumn, measure.label, measure.description, ...(measure.synonyms ?? [])].filter(Boolean).join(" ")
    }))
  ].flatMap((item) => {
    const normalized = item.text.toLocaleLowerCase();
    const matchedTokens = tokens.filter((token) => normalized.includes(token));
    return matchedTokens.length ? [{
      kind: item.kind,
      name: item.name,
      label: item.label,
      matchedTokens,
      score: Number((matchedTokens.length / tokens.length).toFixed(3))
    }] : [];
  }).sort((left, right) => right.score - left.score);
  return matches.length ? matches.slice(0, 10) : undefined;
}

function normalizeSearchTokens(query: string): string[] {
  const normalized = query.toLocaleLowerCase().replace(/[^a-z0-9_\u3400-\u9fff]+/g, " ");
  const tokens = new Set<string>();
  for (const value of normalized.match(/[a-z0-9_]+/g) ?? []) if (value.length >= 2) tokens.add(value);
  for (const sequence of normalized.match(/[\u3400-\u9fff]+/g) ?? []) {
    for (const size of [2, 3]) {
      for (let index = 0; index <= sequence.length - size; index += 1) tokens.add(sequence.slice(index, index + size));
    }
  }
  return Array.from(tokens);
}

function summarizeDashboardParameterMappings(asset: DataAsset) {
  const mappings = asset.dashboardParameterMappings ?? [];
  return asset.parameters?.map((parameter) => {
    const parameterMappings = mappings.filter((mapping) => mapping.parameterId === parameter.name);
    return {
      name: parameter.name,
      label: parameter.label,
      mappedCardCount: new Set(parameterMappings.map((mapping) => mapping.cardId)).size,
      mappedCards: parameterMappings.slice(0, 10).map((mapping) => ({
        cardId: mapping.cardId,
        title: mapping.cardTitle
      }))
    };
  });
}

export function toTextPayload(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}

export function toLimitedTextPayload(value: unknown, maxBytes: number) {
  const json = JSON.stringify(value, null, 2);
  if (Buffer.byteLength(json, "utf8") <= maxBytes) {
    return {
      content: [
        {
          type: "text" as const,
          text: json
        }
      ]
    };
  }

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            error: "response_too_large",
            message: "The response exceeded the configured byte limit. Request fewer rows or narrower metadata.",
            maxResponseBytes: maxBytes
          },
          null,
          2
        )
      }
    ]
  };
}

export function assetNotFound(id: string) {
  return toTextPayload({
    error: "asset_not_found",
    message: `No data asset found for id: ${id}`
  });
}
