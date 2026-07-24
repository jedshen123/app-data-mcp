import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeAssetSearchIntent,
  buildAssetSelectionSummary,
  evaluateModelAggregationSelection,
  orderAssetsByGovernancePriority,
  rankAssetsForQuestion
} from "./assetSelectionGovernance.js";
import type { DataAsset } from "./types.js";

const metric: DataAsset = {
  id: "metabase:metric:483",
  platform: "metabase",
  type: "metric",
  title: "智能设备绑定总用户数",
  tags: [],
  url: "https://metabase.example/metric/483"
};

const model: DataAsset = {
  id: "metabase:model:492",
  platform: "metabase",
  type: "model",
  title: "APP用户设备绑定信息表",
  tags: [],
  url: "https://metabase.example/model/492"
};

const card: DataAsset = {
  id: "metabase:card:510",
  platform: "metabase",
  type: "card",
  title: "智能设备绑定日报",
  tags: [],
  url: "https://metabase.example/question/510"
};

const dashboard: DataAsset = {
  id: "metabase:dashboard:12",
  platform: "metabase",
  type: "dashboard",
  title: "智能设备业务总览",
  tags: [],
  url: "https://metabase.example/dashboard/12"
};

const insight: DataAsset = {
  id: "posthog:insight:retention",
  platform: "posthog",
  type: "insight",
  title: "设备用户留存",
  tags: [],
  url: "https://posthog.example/insights/retention"
};

test("orders governance fallback as Metric > Card > Model", () => {
  const ordered = orderAssetsByGovernancePriority([model, card, metric]);
  const summary = buildAssetSelectionSummary(ordered);
  assert.deepEqual(ordered.map((asset) => asset.id), [metric.id, card.id, model.id]);
  assert.equal(summary.recommendedAssetId, metric.id);
  assert.deepEqual(summary.candidateOrder, [metric.id, card.id, model.id]);
});

test("uses Metric > Card > Model as the safe metric-query route", () => {
  const ranking = rankAssetsForQuestion(
    [card, model, metric, dashboard],
    "最近 30 天绑定设备的用户数趋势"
  );
  assert.equal(ranking.intent.type, "trend_query");
  assert.deepEqual(ranking.assets.map((asset) => asset.id), [
    metric.id,
    card.id,
    model.id,
    dashboard.id
  ]);
  assert.equal(ranking.assessments.get(card.id)?.suitability, "capable");
});

test("routes governed metric_set Cards ahead of Models for metric analysis", () => {
  const metricSetCard: DataAsset = {
    ...card,
    semantic: {
      role: "metric_set",
      baseGrain: ["stat_date"],
      defaultTimeDimension: { field: "stat_date", defaultUnit: "day" },
      dimensions: [{ field: "stat_date" }],
      measures: [{ name: "bound_users", rollup: { strategy: "sum" } }]
    }
  };
  const ranking = rankAssetsForQuestion(
    [model, metricSetCard, metric],
    "最近 30 天绑定用户数趋势"
  );
  assert.deepEqual(ranking.assets.map((asset) => asset.id), [
    metric.id,
    card.id,
    model.id
  ]);
  assert.equal(ranking.assessments.get(card.id)?.suitability, "capable");
});

test("prefers a precomputed metric-set Card over a Metric", () => {
  const precomputedCard: DataAsset = {
    ...card,
    semantic: {
      role: "metric_set",
      baseGrain: ["stat_date"],
      dimensions: [{ field: "stat_date" }],
      measures: [{ name: "bound_users", rollup: { strategy: "sum" } }],
      execution: { mode: "precomputed", cost: { tier: "low", expectedP95Ms: 300 } }
    }
  };
  const ranking = rankAssetsForQuestion([metric, precomputedCard, model], "绑定用户数趋势");
  assert.deepEqual(ranking.assets.map((asset) => asset.id), [card.id, metric.id, model.id]);
  assert.match(ranking.assessments.get(card.id)?.reasons.join(" ") ?? "", /precomputed/);
});

test("routes detail questions to a Model with field metadata", () => {
  const describedModel: DataAsset = {
    ...model,
    columns: [
      {
        name: "device_model",
        displayName: "设备型号",
        type: "type/Text",
        description: "用户当前绑定的设备型号"
      }
    ]
  };
  const ranking = rankAssetsForQuestion(
    [card, metric, describedModel],
    "查询绑定用户明细和设备型号"
  );
  assert.equal(ranking.intent.type, "detail_query");
  assert.equal(ranking.assets[0]?.id, model.id);
  assert.equal(ranking.assessments.get(model.id)?.suitability, "direct");
});

test("routes overview, saved-report, and behavior questions dynamically", () => {
  const overview = rankAssetsForQuestion(
    [metric, card, dashboard],
    "查看智能设备业务整体情况"
  );
  assert.equal(overview.intent.type, "overview_query");
  assert.equal(overview.assets[0]?.id, dashboard.id);

  const saved = rankAssetsForQuestion(
    [metric, model, card],
    "打开智能设备绑定日报"
  );
  assert.equal(saved.intent.type, "saved_query");
  assert.equal(saved.assets[0]?.id, card.id);

  const behavior = rankAssetsForQuestion(
    [dashboard, model, insight],
    "分析设备用户留存"
  );
  assert.equal(behavior.intent.type, "behavior_analysis");
  assert.equal(behavior.assets[0]?.id, insight.id);
});

test("returns explainable intent metadata in the selection summary", () => {
  const intent = analyzeAssetSearchIntent("查询绑定用户明细");
  const ranking = rankAssetsForQuestion([card, model], "查询绑定用户明细");
  const summary = buildAssetSelectionSummary(ranking.assets, intent);
  assert.equal(summary.mode, "intent_aware");
  assert.equal(summary.intent?.type, "detail_query");
  assert.equal(summary.recommendedAssetId, model.id);
});

test("requires the original question for Model aggregations", () => {
  const decision = evaluateModelAggregationSelection(model, [metric], { hasAggregations: true });
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, "asset_question_required");
});

test("blocks a Model aggregation while a Metric or Card candidate remains", () => {
  const decision = evaluateModelAggregationSelection(model, [card, metric], {
    question: "查询中国地区绑定设备的用户数",
    hasAggregations: true
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, "higher_priority_asset_available");
  assert.deepEqual(decision.candidates.map((asset) => asset.id), [metric.id, card.id]);
});

test("allows Model aggregation only after Metrics and Cards are rejected with a reason", () => {
  const withoutReason = evaluateModelAggregationSelection(model, [metric, card], {
    question: "查询中国地区绑定设备的用户数",
    rejectedAssetIds: [metric.id, card.id],
    hasAggregations: true
  });
  assert.equal(withoutReason.code, "fallback_reason_required");

  const withReason = evaluateModelAggregationSelection(model, [metric, card], {
    question: "查询中国地区绑定设备的用户数",
    rejectedAssetIds: [metric.id, card.id],
    fallbackReason: "Metric 不包含实验分组维度，Card 也没有该筛选参数",
    hasAggregations: true
  });
  assert.equal(withReason.allowed, true);
});

test("does not block Model detail queries", () => {
  const decision = evaluateModelAggregationSelection(model, [metric], {
    hasAggregations: false
  });
  assert.equal(decision.allowed, true);
});
