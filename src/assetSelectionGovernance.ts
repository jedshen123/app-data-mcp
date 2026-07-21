import type { DataAsset } from "./types.js";

export const ASSET_TYPE_PRIORITY = {
  metric: 1,
  model: 2,
  card: 3,
  dashboard: 4,
  insight: 5,
  table: 6,
  event: 7
} as const;

export type AssetSelectionDecision = {
  allowed: boolean;
  code?: "asset_question_required" | "fallback_reason_required" | "higher_priority_metric_available";
  message?: string;
  candidates: DataAsset[];
};

export function orderAssetsByGovernancePriority(assets: DataAsset[]): DataAsset[] {
  return assets
    .map((asset, index) => ({ asset, index }))
    .sort((left, right) =>
      ASSET_TYPE_PRIORITY[left.asset.type] - ASSET_TYPE_PRIORITY[right.asset.type]
      || left.index - right.index
    )
    .map(({ asset }) => asset);
}

export function buildAssetSelectionSummary(assets: DataAsset[]) {
  const recommended = assets.find((asset) => asset.type === "metric")
    ?? assets.find((asset) => asset.type === "model")
    ?? assets[0];

  return {
    policy: "Metric > Model > Card > Dashboard. Inspect matching Metrics before using a Model to recompute an aggregation.",
    recommendedAssetId: recommended?.id,
    candidateOrder: assets.map((asset) => asset.id),
    requiresGetAsset: Boolean(recommended)
  };
}

export function summarizeSelectionRank(asset: DataAsset, rank: number, recommendedAssetId?: string) {
  return {
    rank,
    typePriority: ASSET_TYPE_PRIORITY[asset.type],
    recommended: asset.id === recommendedAssetId
  };
}

export function evaluateModelAggregationSelection(
  asset: DataAsset,
  metricCandidates: DataAsset[],
  input: {
    question?: string;
    rejectedAssetIds?: string[];
    fallbackReason?: string;
    hasAggregations: boolean;
  }
): AssetSelectionDecision {
  if (asset.type !== "model" || !input.hasAggregations) {
    return { allowed: true, candidates: [] };
  }

  if (!input.question?.trim()) {
    return {
      allowed: false,
      code: "asset_question_required",
      message: "使用 Model 重新聚合指标时必须提供原始 question，以便服务端先检查是否存在治理 Metric。",
      candidates: []
    };
  }

  const metrics = metricCandidates.filter((candidate) => candidate.type === "metric");
  const rejected = new Set(input.rejectedAssetIds ?? []);
  const rejectedMetrics = metrics.filter((candidate) => rejected.has(candidate.id));
  if (rejectedMetrics.length > 0 && !input.fallbackReason?.trim()) {
    return {
      allowed: false,
      code: "fallback_reason_required",
      message: "说明候选 Metric 不适用的具体原因后，才能降级到 Model 重新聚合。",
      candidates: rejectedMetrics
    };
  }

  const remaining = metrics.filter((candidate) => !rejected.has(candidate.id));
  if (remaining.length > 0) {
    return {
      allowed: false,
      code: "higher_priority_metric_available",
      message: "发现更高优先级的治理 Metric。请先调用 get_asset 检查公式和维度，再运行 Metric；只有确认所有候选 Metric 均不适用后才能降级到 Model。",
      candidates: remaining
    };
  }

  return { allowed: true, candidates: [] };
}
