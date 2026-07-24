import type { DataAsset } from "./types.js";

export const ASSET_TYPE_PRIORITY = {
  metric: 1,
  card: 2,
  model: 3,
  dashboard: 4,
  insight: 5,
  table: 6,
  event: 7
} as const;

export type AssetSearchIntent =
  | "metric_query"
  | "trend_query"
  | "breakdown_query"
  | "detail_query"
  | "overview_query"
  | "saved_query"
  | "behavior_analysis"
  | "lineage_query"
  | "audience_query"
  | "general_query";

export type IntentAnalysis = {
  type: AssetSearchIntent;
  confidence: number;
  signals: string[];
  routingPolicy: string;
};

export type AssetSuitability = "direct" | "capable" | "limited" | "fallback";

export type RankedAssetSelection = {
  suitability: AssetSuitability;
  intentPriority: number;
  reasons: string[];
  missingCapabilities: string[];
};

export type IntentAwareAssetRanking = {
  intent: IntentAnalysis;
  assets: DataAsset[];
  assessments: Map<string, RankedAssetSelection>;
};

export type AssetSelectionDecision = {
  allowed: boolean;
  code?: "asset_question_required" | "fallback_reason_required" | "higher_priority_asset_available";
  message?: string;
  candidates: DataAsset[];
};

export function orderAssetsByGovernancePriority(assets: DataAsset[]): DataAsset[] {
  return assets
    .map((asset, index) => ({ asset, index }))
    .sort((left, right) =>
      governancePriority(left.asset) - governancePriority(right.asset)
      || left.index - right.index
    )
    .map(({ asset }) => asset);
}

const INTENT_PATTERNS: Array<{
  type: AssetSearchIntent;
  confidence: number;
  patterns: RegExp[];
}> = [
  {
    type: "audience_query",
    confidence: 0.98,
    patterns: [/人群/, /用户包/, /交集/, /并集/, /差集/, /\buid\b/i, /导出.*用户/]
  },
  {
    type: "lineage_query",
    confidence: 0.97,
    patterns: [/口径/, /怎么算/, /如何计算/, /数据来源/, /血缘/, /依赖/, /来自哪里/]
  },
  {
    type: "behavior_analysis",
    confidence: 0.96,
    patterns: [/漏斗/, /留存/, /路径/, /行为序列/, /事件分析/, /转化步骤/, /\bfunnel\b/i, /\bretention\b/i]
  },
  {
    type: "detail_query",
    confidence: 0.95,
    patterns: [/明细/, /详情记录/, /原始记录/, /哪些用户/, /用户列表/, /设备列表/, /逐条/, /每一条/]
  },
  {
    type: "overview_query",
    confidence: 0.94,
    patterns: [/整体情况/, /总体情况/, /业务总览/, /经营概览/, /全貌/, /大盘/, /看板/]
  },
  {
    type: "saved_query",
    confidence: 0.92,
    patterns: [/报表/, /日报/, /周报/, /月报/, /固定报告/, /现成.*(?:卡片|查询)/]
  },
  {
    type: "breakdown_query",
    confidence: 0.9,
    patterns: [/按.+(?:拆分|分组|统计|汇总)/, /分(?:国家|地区|渠道|型号|版本|平台|品类)/, /\bbreakdown\b/i]
  },
  {
    type: "trend_query",
    confidence: 0.88,
    patterns: [/趋势/, /走势/, /每天/, /每日/, /每周/, /每月/, /按日/, /按周/, /按月/, /环比/, /同比/]
  },
  {
    type: "metric_query",
    confidence: 0.82,
    patterns: [/多少/, /数量/, /人数/, /次数/, /金额/, /占比/, /比例/, /转化率/, /平均/, /总数/, /去重/]
  }
];

const INTENT_TYPE_ORDER: Record<AssetSearchIntent, DataAsset["type"][]> = {
  metric_query: ["metric", "card", "model", "dashboard", "insight", "table", "event"],
  trend_query: ["metric", "card", "model", "dashboard", "insight", "table", "event"],
  breakdown_query: ["metric", "card", "model", "dashboard", "insight", "table", "event"],
  detail_query: ["model", "card", "table", "metric", "dashboard", "insight", "event"],
  overview_query: ["dashboard", "card", "metric", "model", "insight", "table", "event"],
  saved_query: ["card", "dashboard", "metric", "model", "insight", "table", "event"],
  behavior_analysis: ["insight", "dashboard", "metric", "card", "model", "event", "table"],
  lineage_query: ["metric", "card", "model", "dashboard", "insight", "table", "event"],
  audience_query: ["model", "metric", "card", "dashboard", "insight", "table", "event"],
  general_query: ["metric", "card", "model", "dashboard", "insight", "table", "event"]
};

export function analyzeAssetSearchIntent(question: string): IntentAnalysis {
  const normalized = question.trim();
  for (const candidate of INTENT_PATTERNS) {
    const signals = candidate.patterns
      .map((pattern) => normalized.match(pattern)?.[0])
      .filter((signal): signal is string => Boolean(signal));
    if (signals.length > 0) {
      return {
        type: candidate.type,
        confidence: Math.min(0.99, candidate.confidence + (signals.length - 1) * 0.02),
        signals,
        routingPolicy: describeRoutingPolicy(candidate.type)
      };
    }
  }
  return {
    type: "general_query",
    confidence: normalized ? 0.55 : 0.2,
    signals: [],
    routingPolicy: describeRoutingPolicy("general_query")
  };
}

export function rankAssetsForQuestion(assets: DataAsset[], question: string): IntentAwareAssetRanking {
  const intent = analyzeAssetSearchIntent(question);
  const typeOrder = INTENT_TYPE_ORDER[intent.type];
  const assessments = new Map<string, RankedAssetSelection>();
  const ranked = assets
    .map((asset, relevanceRank) => {
      const intentPriority = metricSetIntentPriority(asset, intent.type)
        ?? typeOrder.indexOf(asset.type) + 1;
      const assessment = assessAssetForIntent(asset, intent.type, intentPriority);
      assessments.set(asset.id, assessment);
      return { asset, relevanceRank, intentPriority };
    })
    .sort((left, right) =>
      left.intentPriority - right.intentPriority
      || left.relevanceRank - right.relevanceRank
    )
    .map(({ asset }) => asset);

  return { intent, assets: ranked, assessments };
}

export function buildAssetSelectionSummary(assets: DataAsset[], intent?: IntentAnalysis) {
  const recommended = assets[0];

  return {
    policy: intent?.routingPolicy
      ?? "Precomputed/cached metric-set Card > Metric > live Card > Model for metric analysis. Inspect governed definitions before recomputing.",
    mode: intent ? "intent_aware" : "governance_fallback",
    intent,
    recommendedAssetId: recommended?.id,
    candidateOrder: assets.map((asset) => asset.id),
    requiresGetAsset: Boolean(recommended)
  };
}

export function summarizeSelectionRank(
  asset: DataAsset,
  rank: number,
  recommendedAssetId?: string,
  assessment?: RankedAssetSelection
) {
  return {
    rank,
    typePriority: governancePriority(asset),
    recommended: asset.id === recommendedAssetId,
    ...(assessment ?? {})
  };
}

function describeRoutingPolicy(intent: AssetSearchIntent): string {
  return `Intent-aware ${intent}: ${INTENT_TYPE_ORDER[intent].join(" > ")}. Relevance is preserved within the same intent/type tier; inspect metadata before execution.`;
}

function assessAssetForIntent(
  asset: DataAsset,
  intent: AssetSearchIntent,
  intentPriority: number
): RankedAssetSelection {
  const reasons = [`资产类型符合 ${intent} 的第 ${intentPriority} 级候选顺序`];
  const missingCapabilities: string[] = [];
  let suitability: AssetSuitability = intentPriority === 1 ? "direct" : "capable";

  if (asset.type === "model") {
    const describedColumns = asset.columns?.filter((column) => column.description?.trim()).length ?? 0;
    reasons.push(`Model 提供字段元数据${describedColumns ? `，其中 ${describedColumns} 个字段有业务说明` : ""}`);
    if (!asset.columns?.length) {
      missingCapabilities.push("缺少同步字段元数据");
      suitability = "limited";
    }
    if (!asset.modelSemantic || asset.modelSemantic.aggregationPolicy === "detail_only") {
      reasons.push("Model 默认仅用于明细查询，不允许临时 count、distinct、sum");
    } else {
      reasons.push("Model 仅允许按已声明的粒度、实体字段和可加字段做受控聚合");
    }
  }

  if (asset.type === "card" && asset.semantic?.role === "metric_set") {
    reasons.push(`Card 指标集声明了 ${asset.semantic.measures.length} 个指标、${asset.semantic.dimensions.length} 个维度和受控 Rollup 规则`);
    if (asset.semantic.defaultTimeDimension) {
      reasons.push(`默认时间维度为 ${asset.semantic.defaultTimeDimension.field}`);
    }
    if (["precomputed", "cached"].includes(asset.semantic.execution?.mode ?? "")) {
      reasons.push(`Card 执行模式为 ${asset.semantic.execution?.mode}，优先复用已计算结果`);
    }
  } else if (asset.type === "card" && intent !== "saved_query") {
    reasons.push("Card 可直接提供已保存的业务结果，应在使用 Model 重算前核对其参数和输出列");
    missingCapabilities.push("需要通过 get_asset 核对固定筛选、参数和输出口径");
    suitability = intentPriority <= 2 ? "capable" : "limited";
  }

  if (asset.type === "dashboard" && !["overview_query", "saved_query"].includes(intent)) {
    reasons.push("Dashboard 是多资产容器，适合作为发现入口而非单指标默认执行对象");
    missingCapabilities.push("可能包含超出当前问题范围的 Card");
    suitability = "fallback";
  }

  if (asset.type === "metric") {
    reasons.push("Metric 保留已治理公式，适合指标、趋势和拆分查询");
    if (["detail_query", "audience_query"].includes(intent)) {
      missingCapabilities.push("Metric 不适合返回底层逐条明细");
      suitability = "fallback";
    }
  }

  if (asset.type === "insight" && intent === "behavior_analysis") {
    reasons.push("PostHog Insight 适合漏斗、留存、路径和事件分析");
  }

  return { suitability, intentPriority, reasons, missingCapabilities };
}

function metricSetIntentPriority(asset: DataAsset, intent: AssetSearchIntent): number | undefined {
  if (asset.type !== "card" || asset.semantic?.role !== "metric_set") return undefined;
  if (["metric_query", "trend_query", "breakdown_query", "lineage_query", "general_query"].includes(intent)) {
    return ["precomputed", "cached"].includes(asset.semantic.execution?.mode ?? "") ? 0.5 : 1.5;
  }
  return undefined;
}

function governancePriority(asset: DataAsset): number {
  if (
    asset.type === "card"
    && asset.semantic?.role === "metric_set"
    && ["precomputed", "cached"].includes(asset.semantic.execution?.mode ?? "")
  ) {
    return 0.5;
  }
  return ASSET_TYPE_PRIORITY[asset.type];
}

export function evaluateModelAggregationSelection(
  asset: DataAsset,
  higherPriorityCandidates: DataAsset[],
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
      message: "使用 Model 重新聚合指标时必须提供原始 question，以便服务端先检查是否存在可直接回答的 Metric 或 Card。",
      candidates: []
    };
  }

  const governedCandidates = orderAssetsByGovernancePriority(
    higherPriorityCandidates.filter((candidate) =>
      candidate.type === "metric" || candidate.type === "card"
    )
  );
  const rejected = new Set(input.rejectedAssetIds ?? []);
  const rejectedCandidates = governedCandidates.filter((candidate) => rejected.has(candidate.id));
  if (rejectedCandidates.length > 0 && !input.fallbackReason?.trim()) {
    return {
      allowed: false,
      code: "fallback_reason_required",
      message: "说明候选 Metric 或 Card 不适用的具体原因后，才能降级到 Model 重新聚合。",
      candidates: rejectedCandidates
    };
  }

  const remaining = governedCandidates.filter((candidate) => !rejected.has(candidate.id));
  if (remaining.length > 0) {
    return {
      allowed: false,
      code: "higher_priority_asset_available",
      message: "发现更高优先级的 Metric 或 Card。请先调用 get_asset 检查公式、指标、参数和输出列，再运行可直接回答问题的资产；只有确认所有候选均不适用后才能降级到 Model。",
      candidates: remaining
    };
  }

  return { allowed: true, candidates: [] };
}
