import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAssetSelectionSummary,
  evaluateModelAggregationSelection,
  orderAssetsByGovernancePriority
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

test("orders and recommends a Metric ahead of a more relevant Model candidate", () => {
  const ordered = orderAssetsByGovernancePriority([model, metric]);
  const summary = buildAssetSelectionSummary(ordered);
  assert.deepEqual(ordered.map((asset) => asset.id), [metric.id, model.id]);
  assert.equal(summary.recommendedAssetId, metric.id);
  assert.deepEqual(summary.candidateOrder, [metric.id, model.id]);
});

test("requires the original question for Model aggregations", () => {
  const decision = evaluateModelAggregationSelection(model, [metric], { hasAggregations: true });
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, "asset_question_required");
});

test("blocks a Model aggregation while a Metric candidate remains", () => {
  const decision = evaluateModelAggregationSelection(model, [metric], {
    question: "查询中国地区绑定设备的用户数",
    hasAggregations: true
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, "higher_priority_metric_available");
  assert.equal(decision.candidates[0]?.id, metric.id);
});

test("allows Model aggregation only after Metrics are rejected with a reason", () => {
  const withoutReason = evaluateModelAggregationSelection(model, [metric], {
    question: "查询中国地区绑定设备的用户数",
    rejectedAssetIds: [metric.id],
    hasAggregations: true
  });
  assert.equal(withoutReason.code, "fallback_reason_required");

  const withReason = evaluateModelAggregationSelection(model, [metric], {
    question: "查询中国地区绑定设备的用户数",
    rejectedAssetIds: [metric.id],
    fallbackReason: "该 Metric 不包含用户要求的实验分组维度",
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
