import assert from "node:assert/strict";
import test from "node:test";
import {
  buildEffectiveInstructions,
  resolveAvailableToolNames,
  type ManagedTool
} from "./toolStore.js";

const tools: ManagedTool[] = [
  {
    name: "search_assets",
    title: "搜索数据资产",
    description: "",
    category: "资产发现",
    riskLevel: "low",
    enabled: true,
    updatedAt: new Date(0).toISOString(),
    inputSchema: {},
    usageNotes: ""
  },
  {
    name: "query_starrocks",
    title: "查询 StarRocks",
    description: "",
    category: "数据查询",
    riskLevel: "high",
    enabled: false,
    updatedAt: new Date(0).toISOString(),
    inputSchema: {},
    usageNotes: ""
  },
  {
    name: "export_audience",
    title: "导出用户人群",
    description: "",
    category: "数据导出",
    riskLevel: "high",
    enabled: false,
    updatedAt: new Date(0).toISOString(),
    inputSchema: {},
    usageNotes: ""
  }
];

test("disabled high-risk tools are absent without a user grant", () => {
  assert.deepEqual([...resolveAvailableToolNames(tools, new Set())], ["search_assets"]);
});

test("a user grant adds only an approved high-risk tool", () => {
  assert.deepEqual(
    [...resolveAvailableToolNames(tools, new Set(["query_starrocks", "search_assets"]))],
    ["search_assets", "query_starrocks"]
  );
});

test("instructions do not disclose tools hidden from the current user", () => {
  const available = resolveAvailableToolNames(tools, new Set(["export_audience"]));
  const instructions = buildEffectiveInstructions(
    "先调用 search_assets。只有必要时调用 query_starrocks。完整文件使用 export_audience。不要暴露密钥。",
    tools,
    available
  );

  assert.match(instructions, /search_assets/);
  assert.match(instructions, /export_audience/);
  assert.doesNotMatch(instructions, /query_starrocks/);
  assert.doesNotMatch(instructions, /未开放|禁用/);
});
