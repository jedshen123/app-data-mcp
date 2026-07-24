import assert from "node:assert/strict";
import test from "node:test";
import { findPublishedDashboardParents, searchCatalogAssets, summarizeCatalogAssets } from "./catalog.js";
import type { DataAsset } from "./types.js";

const assets: DataAsset[] = [
  {
    id: "metabase:metric:480",
    platform: "metabase",
    type: "metric",
    title: "活跃日期当天有效绑定设备的去重用户数",
    description: "统计事件日期当天与智能设备有效绑定的整体活跃去重用户数",
    businessDomain: "社区活跃",
    tags: ["绑定", "活跃用户"],
    url: "https://metabase.example/metric/480",
    metric: {
      dimensions: [
        { name: "model", displayName: "设备型号", type: "type/Text" },
        { name: "event_date", displayName: "活跃日期", type: "type/Date" }
      ]
    }
  },
  {
    id: "metabase:card:473",
    platform: "metabase",
    type: "card",
    title: "社区帖子评论表",
    description: "社区UCG帖子评论明细",
    tags: ["社区"],
    url: "https://metabase.example/question/473"
  },
  {
    id: "metabase:card:999",
    platform: "metabase",
    type: "card",
    title: "财务收入日报",
    tags: ["收入"],
    url: "https://metabase.example/question/999"
  },
  {
    id: "metabase:card:1001",
    platform: "metabase",
    type: "card",
    title: "支付核心指标日报",
    tags: ["支付"],
    url: "https://metabase.example/question/1001",
    semantic: {
      role: "metric_set",
      baseGrain: ["stat_date", "region"],
      defaultTimeDimension: { field: "stat_date", defaultUnit: "day", dateMeaning: "支付成功日期" },
      dimensions: [
        { field: "stat_date", label: "统计日期" },
        { field: "region", label: "地区" }
      ],
      measures: [{
        name: "paid_users",
        label: "支付用户数",
        description: "支付成功的去重用户数",
        synonyms: ["付费用户数"],
        rollup: { strategy: "forbidden" }
      }]
    }
  }
];

test("matches a Chinese natural-language question and prioritizes Metric", () => {
  const result = searchCatalogAssets(assets, {
    query: "请查询最近15天有效绑定M9设备的社区活跃用户数趋势",
    platform: "metabase"
  }, 10);
  assert.equal(result[0]?.id, "metabase:metric:480");
  assert.ok(!result.some((asset) => asset.id === "metabase:card:999"));
});

test("retains exact short keyword search", () => {
  const result = searchCatalogAssets(assets, { query: "收入" }, 10);
  assert.deepEqual(result.map((asset) => asset.id), ["metabase:card:999"]);
});

test("searches metric_set Card measure labels, descriptions, and synonyms", () => {
  const result = searchCatalogAssets(assets, { query: "付费用户数" }, 10);
  assert.equal(result[0]?.id, "metabase:card:1001");
});

test("summarizes only the assets passed by the caller", () => {
  const summary = summarizeCatalogAssets(assets.slice(0, 2));
  assert.deepEqual(summary, {
    assetCount: 2,
    byPlatform: { metabase: 2 },
    byType: { metric: 1, card: 1 }
  });
});

test("finds unpublished Cards only through their published parent Dashboard", () => {
  const dashboard: DataAsset = {
    id: "metabase:dashboard:88",
    platform: "metabase",
    type: "dashboard",
    title: "经营看板",
    tags: [],
    url: "https://metabase.example/dashboard/88",
    children: ["metabase:card:473"]
  };
  const parents = findPublishedDashboardParents([...assets, dashboard], "metabase:card:473");
  assert.deepEqual(parents.map((asset) => asset.id), ["metabase:dashboard:88"]);
  assert.deepEqual(findPublishedDashboardParents([...assets, dashboard], "metabase:card:999"), []);
});
