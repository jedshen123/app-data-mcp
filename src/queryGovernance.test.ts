import assert from "node:assert/strict";
import test from "node:test";
import { evaluateSqlGovernance } from "./queryGovernance.js";
import type { DataAsset } from "./types.js";

const metric: DataAsset = {
  id: "metabase:metric:480",
  platform: "metabase",
  type: "metric",
  title: "有效绑定设备活跃用户数",
  tags: [],
  url: "https://metabase.example/metric/480"
};

test("blocks SQL when a governed asset is available", () => {
  const decision = evaluateSqlGovernance([metric], {
    sql: "select count(*) from users",
    purpose: "data_question"
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, "governed_assets_available");
  assert.equal(decision.candidates[0].id, metric.id);
});

test("allows SQL after candidates are explicitly rejected with a reason", () => {
  const decision = evaluateSqlGovernance([metric], {
    sql: "select count(*) from users",
    purpose: "data_question",
    rejectedAssetIds: [metric.id],
    fallbackReason: "该指标不包含用户要求的实验分组"
  });
  assert.equal(decision.allowed, true);
});

test("allows explicit SQL and restricts metadata inspection purpose", () => {
  assert.equal(evaluateSqlGovernance([metric], {
    sql: "select 1",
    purpose: "user_requested_sql"
  }).allowed, true);
  assert.equal(evaluateSqlGovernance([metric], {
    sql: "describe users",
    purpose: "metadata_inspection"
  }).allowed, true);
  assert.equal(evaluateSqlGovernance([], {
    sql: "select * from users",
    purpose: "metadata_inspection"
  }).allowed, false);
});
