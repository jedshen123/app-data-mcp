import assert from "node:assert/strict";
import test from "node:test";
import { buildMetabaseSemanticQuery } from "./metabase.js";
import type { DataAsset } from "../types.js";

const dimensions = [
  { name: "uid", displayName: "用户ID", type: "type/Text", fieldRef: ["field", { "base-type": "type/Text" }, "uid"] },
  { name: "event_date", displayName: "活跃日期", type: "type/Date", fieldRef: ["field", { "base-type": "type/Date" }, "event_date"] },
  { name: "country", displayName: "国家", type: "type/Text", fieldRef: ["field", { "base-type": "type/Text" }, "country"] },
  { name: "amount", displayName: "金额", type: "type/Float", fieldRef: ["field", { "base-type": "type/Float" }, "amount"] }
];

test("builds validated Model aggregations, filters, and breakouts", () => {
  const asset: DataAsset = {
    id: "metabase:model:479",
    platform: "metabase",
    type: "model",
    title: "用户活跃明细",
    tags: [],
    url: "https://metabase.example/model/479",
    queryText: JSON.stringify({ "lib/type": "mbql/query", database: 4, stages: [] }),
    columns: dimensions
  };
  const query = buildMetabaseSemanticQuery(asset, {
    filters: [{ field: "国家", operator: "in", value: ["CN", "US"] }],
    aggregations: [{ operator: "distinct", field: "uid", alias: "用户数" }],
    breakouts: [{ field: "活跃日期", unit: "month" }]
  }, 100);
  const stage = (query.stages as Record<string, unknown>[])[0];

  assert.equal(query.database, 4);
  assert.equal(stage["source-card"], 479);
  assert.equal(stage.limit, 101);
  assert.deepEqual((stage.filters as unknown[][])[0].slice(0, 1), ["="]);
  assert.deepEqual((stage.aggregation as unknown[][])[0][0], "distinct");
  assert.deepEqual(((stage.breakout as unknown[][])[0][1] as Record<string, unknown>)["temporal-unit"], "month");
});

test("preserves a governed Metric formula while replacing default breakouts", () => {
  const asset: DataAsset = {
    id: "metabase:metric:480",
    platform: "metabase",
    type: "metric",
    title: "活跃用户数",
    tags: [],
    url: "https://metabase.example/metric/480",
    queryText: JSON.stringify({
      "lib/type": "mbql/query",
      database: 4,
      stages: [{
        "lib/type": "mbql.stage/mbql",
        "source-card": 479,
        aggregation: [["distinct", { "lib/uuid": "formula" }, ["field", { "base-type": "type/Text" }, "uid"]]],
        breakout: [["field", { "base-type": "type/Date", "temporal-unit": "day" }, "event_date"]]
      }]
    }),
    metric: { dimensions }
  };
  const query = buildMetabaseSemanticQuery(asset, {
    filters: [{ field: "country", operator: "eq", value: "CN" }],
    breakouts: []
  }, 50);
  const stage = (query.stages as Record<string, unknown>[])[0];

  assert.deepEqual((stage.aggregation as unknown[][])[0][0], "distinct");
  assert.deepEqual(stage.breakout, []);
  assert.equal((stage.filters as unknown[][])[0][0], "=");
  assert.equal(stage.limit, 51);
});

test("rejects unknown fields and attempts to replace a Metric formula", () => {
  const metric: DataAsset = {
    id: "metabase:metric:1",
    platform: "metabase",
    type: "metric",
    title: "Metric",
    tags: [],
    url: "https://metabase.example/metric/1",
    queryText: JSON.stringify({ database: 1, stages: [{ aggregation: [["count", {}]] }] }),
    metric: { dimensions }
  };

  assert.throws(
    () => buildMetabaseSemanticQuery(metric, { aggregations: [{ operator: "count" }] }, 10),
    /metric_formula_immutable/
  );
  assert.throws(
    () => buildMetabaseSemanticQuery(metric, { filters: [{ field: "missing", operator: "eq", value: 1 }] }, 10),
    /field_not_found/
  );
});
