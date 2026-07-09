import fs from "node:fs/promises";
import path from "node:path";
import { getAssetFilePath } from "../config.js";
import type { AssetCatalog, DataAsset, DataPlatform } from "../types.js";

const CURRENT_VERSION = 1;

export function getCatalogPath(): string {
  return path.resolve(process.cwd(), getAssetFilePath());
}

export async function readCatalogOrEmpty(): Promise<AssetCatalog> {
  const filePath = getCatalogPath();

  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as AssetCatalog;
    return {
      version: parsed.version ?? CURRENT_VERSION,
      updatedAt: parsed.updatedAt,
      assets: Array.isArray(parsed.assets) ? parsed.assets : []
    };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return {
        version: CURRENT_VERSION,
        updatedAt: new Date().toISOString(),
        assets: []
      };
    }
    throw error;
  }
}

export async function replacePlatformAssets(platform: DataPlatform, nextAssets: DataAsset[]): Promise<AssetCatalog> {
  const filePath = getCatalogPath();
  const catalog = await readCatalogOrEmpty();
  const retainedAssets = catalog.assets.filter((asset) => asset.platform !== platform);
  const nextCatalog: AssetCatalog = {
    version: catalog.version ?? CURRENT_VERSION,
    updatedAt: new Date().toISOString(),
    assets: [...retainedAssets, ...dedupeAssets(nextAssets)]
  };

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(nextCatalog, null, 2)}\n`, "utf8");
  return nextCatalog;
}

function dedupeAssets(assets: DataAsset[]): DataAsset[] {
  const byId = new Map<string, DataAsset>();
  for (const asset of assets) {
    byId.set(asset.id, asset);
  }
  return Array.from(byId.values()).sort((left, right) => left.id.localeCompare(right.id));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
