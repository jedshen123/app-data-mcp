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
