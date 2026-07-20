import type { DataAsset, SemanticQuery } from "../types.js";
import { runMetabaseAsset } from "./metabase.js";
import { runPostHogAsset } from "./posthog.js";

type RunOptions = {
  params?: Record<string, unknown>;
  semantic?: SemanticQuery;
  limit: number;
};

export async function runLiveAsset(asset: DataAsset, options: RunOptions) {
  if (asset.platform === "metabase") {
    return runMetabaseAsset(asset, options);
  }

  if (asset.platform === "posthog") {
    if (options.semantic) throw new Error("semantic_query_not_supported: Semantic controls are currently limited to Metabase Model and Metric assets.");
    return runPostHogAsset(asset, options);
  }

  throw new Error(`No live connector for platform: ${asset.platform}`);
}
