import assert from "node:assert/strict";
import test from "node:test";
import { applyCardCumulative, buildMetabaseSemanticQuery } from "./metabase.js";
import { validateCardSemanticAgainstAsset } from "../cardSemantic.js";
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
    columns: dimensions,
    modelSemantic: {
      role: "detail_dataset",
      aggregationPolicy: "guarded",
      baseGrain: ["uid", "event_date"],
      entityFields: ["uid"],
      additiveFields: ["amount"],
      requiredFilters: [{ field: "country", operator: "neq", value: "blocked" }]
    }
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
  assert.deepEqual((stage.filters as unknown[][]).map((filter) => filter[0]), ["!=", "="]);
  assert.deepEqual((stage.aggregation as unknown[][])[0][0], "distinct");
  assert.deepEqual(((stage.breakout as unknown[][])[0][1] as Record<string, unknown>)["temporal-unit"], "month");
});

test("keeps Models detail-only unless guarded fields are explicitly declared", () => {
  const detailOnly: DataAsset = {
    id: "metabase:model:480",
    platform: "metabase",
    type: "model",
    title: "订单明细",
    tags: [],
    url: "https://metabase.example/model/480",
    queryText: JSON.stringify({ "lib/type": "mbql/query", database: 4, stages: [] }),
    columns: dimensions
  };
  assert.throws(
    () => buildMetabaseSemanticQuery(detailOnly, { aggregations: [{ operator: "sum", field: "amount" }] }, 10),
    /model_aggregation_disabled/
  );
  const detailQuery = buildMetabaseSemanticQuery(detailOnly, { fields: ["uid", "amount"] }, 10);
  assert.equal((detailQuery.stages as Record<string, unknown>[])[0].limit, 11);
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

const metricSetColumns = [
  { name: "stat_date", displayName: "统计日期", type: "type/Date", fieldRef: ["field", { "base-type": "type/Date" }, "stat_date"] },
  { name: "region", displayName: "地区", type: "type/Text", fieldRef: ["field", { "base-type": "type/Text" }, "region"] },
  { name: "revenue", displayName: "支付金额", type: "type/Float", fieldRef: ["field", { "base-type": "type/Float" }, "revenue"] },
  { name: "paid_orders", displayName: "支付订单数", type: "type/Integer", fieldRef: ["field", { "base-type": "type/Integer" }, "paid_orders"] },
  { name: "paid_users", displayName: "支付用户数", type: "type/Integer", fieldRef: ["field", { "base-type": "type/Integer" }, "paid_users"] },
  { name: "avg_order_value", displayName: "客单价", type: "type/Float", fieldRef: ["field", { "base-type": "type/Float" }, "avg_order_value"] }
];

const metricSetCard: DataAsset = {
  id: "metabase:card:123",
  platform: "metabase",
  type: "card",
  title: "支付核心指标日报",
  tags: [],
  url: "https://metabase.example/question/123",
  queryText: "select ...",
  sourceRefs: [{ system: "metabase", database: "4" }],
  columns: metricSetColumns,
  semantic: {
    role: "metric_set",
    baseGrain: ["stat_date", "region"],
    defaultTimeDimension: {
      field: "stat_date",
      defaultUnit: "month",
      supportedUnits: ["day", "week", "month"]
    },
    dimensions: [
      { field: "stat_date", label: "统计日期" },
      { field: "region", label: "地区" }
    ],
    measures: [
      {
        name: "revenue",
        label: "支付金额",
        rollup: { strategy: "sum", allowedGroupBy: ["stat_date", "region"] },
        cumulative: { supported: true, strategy: "running_sum" }
      },
      {
        name: "paid_orders",
        label: "支付订单数",
        rollup: { strategy: "sum" }
      },
      {
        name: "paid_users",
        label: "支付用户数",
        rollup: { strategy: "forbidden", reason: "跨分组会重复计算用户" },
        cumulative: { supported: false, reason: "日去重人数不能累计求和" }
      },
      {
        name: "avg_order_value",
        label: "客单价",
        rollup: {
          strategy: "recompute",
          formula: { operator: "divide", numerator: "revenue", denominator: "paid_orders" }
        }
      }
    ]
  }
};

test("allows a virtual recompute measure without a same-named Card output column", () => {
  const virtualMeasureCard: DataAsset = {
    ...metricSetCard,
    semantic: {
      ...metricSetCard.semantic!,
      measures: metricSetCard.semantic!.measures.map((measure) =>
        measure.name === "avg_order_value"
          ? { ...measure, sourceColumn: undefined }
          : measure
      )
    }
  };
  virtualMeasureCard.columns = metricSetColumns.filter((column) => column.name !== "avg_order_value");
  assert.doesNotThrow(() => validateCardSemanticAgainstAsset(virtualMeasureCard));
  const query = buildMetabaseSemanticQuery(virtualMeasureCard, {
    measures: ["avg_order_value"],
    breakouts: []
  }, 10);
  const aggregation = ((query.stages as Record<string, unknown>[])[0].aggregation as unknown[][])[0];
  assert.equal(aggregation[0], "/");
});

test("builds governed Card measures using the default time dimension", () => {
  const query = buildMetabaseSemanticQuery(metricSetCard, {
    measures: ["支付金额", "avg_order_value"]
  }, 100);
  const stage = (query.stages as Record<string, unknown>[])[0];
  const aggregations = stage.aggregation as unknown[][];
  const breakout = (stage.breakout as unknown[][])[0];

  assert.equal(query.database, 4);
  assert.equal(stage["source-card"], 123);
  assert.equal(aggregations[0][0], "sum");
  assert.equal((aggregations[0][1] as Record<string, unknown>).name, "revenue");
  assert.equal(aggregations[1][0], "/");
  assert.equal((breakout[1] as Record<string, unknown>)["temporal-unit"], "month");
});

test("blocks unsafe Card rollups and allows non-additive measures only at base grain", () => {
  assert.throws(
    () => buildMetabaseSemanticQuery(metricSetCard, {
      measures: ["paid_users"],
      breakouts: []
    }, 100),
    /measure_rollup_forbidden/
  );

  const query = buildMetabaseSemanticQuery(metricSetCard, {
    measures: ["paid_users"],
    breakouts: [
      { field: "stat_date", unit: "day" },
      { field: "region" }
    ]
  }, 100);
  const aggregation = ((query.stages as Record<string, unknown>[])[0].aggregation as unknown[][])[0];
  assert.equal(aggregation[0], "max");
});

test("validates governed Card running cumulative requests", () => {
  const query = buildMetabaseSemanticQuery(metricSetCard, {
    measures: ["revenue"],
    breakouts: [
      { field: "stat_date", unit: "day" },
      { field: "region" }
    ],
    cumulative: [{
      measure: "revenue",
      orderBy: "stat_date",
      partitionBy: ["region"],
      alias: "revenue_running"
    }]
  }, 100);
  assert.equal((query.stages as Record<string, unknown>[])[0]["source-card"], 123);

  assert.throws(
    () => buildMetabaseSemanticQuery(metricSetCard, {
      measures: ["paid_users"],
      breakouts: [
        { field: "stat_date", unit: "day" },
        { field: "region" }
      ],
      cumulative: [{ measure: "paid_users", orderBy: "stat_date" }]
    }, 100),
    /cumulative_not_supported/
  );
});

test("calculates bounded running sums within breakout partitions", () => {
  const result = applyCardCumulative({
    columns: [
      { name: "stat_date", type: "type/Date" },
      { name: "region", type: "type/Text" },
      { name: "revenue", type: "type/Float" }
    ],
    rows: [
      { stat_date: "2026-07-02", region: "CN", revenue: 3 },
      { stat_date: "2026-07-01", region: "US", revenue: 5 },
      { stat_date: "2026-07-01", region: "CN", revenue: 2 }
    ],
    totalRowsReturned: 3,
    limitApplied: 100,
    truncated: false,
    rawShape: "dataset"
  }, [{
    measure: "revenue",
    orderBy: "stat_date",
    partitionBy: ["region"],
    alias: "revenue_running"
  }], metricSetCard);

  assert.deepEqual(result.rows, [
    { stat_date: "2026-07-01", region: "CN", revenue: 2, revenue_running: 2 },
    { stat_date: "2026-07-02", region: "CN", revenue: 3, revenue_running: 5 },
    { stat_date: "2026-07-01", region: "US", revenue: 5, revenue_running: 5 }
  ]);
  assert.equal(result.columns.at(-1)?.name, "revenue_running");
});

test("rejects non-numeric sum measures in governed Card metadata", () => {
  const invalid: DataAsset = {
    ...metricSetCard,
    semantic: {
      ...metricSetCard.semantic!,
      measures: [{
        name: "region_total",
        sourceColumn: "region",
        rollup: { strategy: "sum" }
      }]
    }
  };
  assert.throws(
    () => buildMetabaseSemanticQuery(invalid, { measures: ["region_total"] }, 100),
    /measure_not_numeric/
  );
});
