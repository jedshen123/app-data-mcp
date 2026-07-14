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
