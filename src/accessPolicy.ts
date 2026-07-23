import { getStoredMetabaseSessionStatus } from "./auth/metabaseSessions.js";
import { getMetabaseConfig } from "./config.js";
import { getRequestContext } from "./requestContext.js";
import { fetchJson, joinUrl } from "./sync/http.js";
import type { DataAsset } from "./types.js";

export type AccessDecision = {
  allowed: boolean;
  reason?: string;
  loginUrl?: string;
};

export function canReadAssetMetadataFromSnapshot(asset: DataAsset, user: string | undefined): AccessDecision {
  const access = asset.access;
  if (!access) return { allowed: true };

  if (access.archived || access.visibility === "archived") {
    return { allowed: false, reason: "asset_archived" };
  }

  if (access.visibility === "personal") {
    const normalizedUser = normalizeEmail(user);
    const ownerEmail = normalizeEmail(access.collectionPersonalOwnerEmail ?? access.creatorEmail);
    if (normalizedUser && ownerEmail && normalizedUser === ownerEmail) return { allowed: true };
    return { allowed: false, reason: "personal_collection_not_owned_by_user" };
  }

  return { allowed: true };
}

export async function canReadAssetMetadataLive(asset: DataAsset): Promise<AccessDecision> {
  if (asset.platform !== "metabase") return { allowed: true };
  if (asset.type !== "card" && asset.type !== "model" && asset.type !== "metric" && asset.type !== "dashboard") return { allowed: true };

  const requestContext = getRequestContext();
  const config = getMetabaseConfig();
  if (!config.baseUrl) {
    return { allowed: false, reason: "metabase_base_url_missing" };
  }

  const sessionStatus = await getStoredMetabaseSessionStatus(requestContext.user);
  const session = requestContext.metabaseSession ?? (sessionStatus.authorized ? sessionStatus.session : undefined);
  if (!session) {
    return { allowed: false, reason: "metabase_session_missing" };
  }

  return checkMetabaseAssetAccess(asset, config.baseUrl, session);
}

export async function filterAssetsByLiveAccess(assets: DataAsset[], concurrency = 8): Promise<DataAsset[]> {
  const metabaseAssets = assets.filter((asset) => isLiveCheckedMetabaseAsset(asset));
  if (!metabaseAssets.length) return assets;

  const requestContext = getRequestContext();
  const config = getMetabaseConfig();
  if (!config.baseUrl) {
    return assets.filter((asset) => !isLiveCheckedMetabaseAsset(asset));
  }
  const baseUrl = config.baseUrl;
  const sessionStatus = await getStoredMetabaseSessionStatus(requestContext.user);
  const session = requestContext.metabaseSession ?? (sessionStatus.authorized ? sessionStatus.session : undefined);
  if (!session) {
    return assets.filter((asset) => !isLiveCheckedMetabaseAsset(asset));
  }

  const allowedMetabaseIds = new Set<string>();
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), metabaseAssets.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < metabaseAssets.length) {
      const asset = metabaseAssets[nextIndex++];
      const decision = await checkMetabaseAssetAccess(asset, baseUrl, session);
      if (decision.allowed) allowedMetabaseIds.add(asset.id);
    }
  }));

  return assets.filter((asset) => !isLiveCheckedMetabaseAsset(asset) || allowedMetabaseIds.has(asset.id));
}

function isLiveCheckedMetabaseAsset(asset: DataAsset): boolean {
  return asset.platform === "metabase" &&
    (asset.type === "card" || asset.type === "model" || asset.type === "metric" || asset.type === "dashboard");
}

async function checkMetabaseAssetAccess(
  asset: DataAsset,
  baseUrl: string,
  session: string
): Promise<AccessDecision> {
  const numericId = asset.id.split(":").pop();
  if (!numericId) return { allowed: false, reason: "invalid_asset_id" };

  const pathname = asset.type === "dashboard" ? `/api/dashboard/${numericId}` : `/api/card/${numericId}`;
  try {
    await fetchJson<unknown>(joinUrl(baseUrl, pathname), {
      headers: {
        "X-Metabase-Session": session
      }
    });
    return { allowed: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("HTTP 401")) return { allowed: false, reason: "metabase_unauthorized" };
    if (message.includes("HTTP 403")) return { allowed: false, reason: "metabase_forbidden" };
    if (message.includes("HTTP 404")) return { allowed: false, reason: "metabase_not_found_or_hidden" };
    return { allowed: false, reason: `metabase_access_check_failed: ${message}` };
  }
}

export function filterAssetsBySnapshotAccess(assets: DataAsset[], user: string | undefined): DataAsset[] {
  return assets.filter((asset) => canReadAssetMetadataFromSnapshot(asset, user).allowed);
}

function normalizeEmail(value: string | undefined): string | undefined {
  const trimmed = value?.trim().toLowerCase();
  return trimmed || undefined;
}
