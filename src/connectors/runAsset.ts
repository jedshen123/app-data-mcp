import type { DataAsset } from "../types.js";
import { runMetabaseAsset } from "./metabase.js";
import { runPostHogAsset } from "./posthog.js";

type RunOptions = {
  params?: Record<string, unknown>;
  limit: number;
};

export async function runLiveAsset(asset: DataAsset, options: RunOptions) {
  if (asset.platform === "metabase") {
    return runMetabaseAsset(asset, options);
  }

  if (asset.platform === "posthog") {
    return runPostHogAsset(asset, options);
  }

  throw new Error(`No live connector for platform: ${asset.platform}`);
}
