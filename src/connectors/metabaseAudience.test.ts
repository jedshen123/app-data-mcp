import assert from "node:assert/strict";
import test from "node:test";
import { buildMetabaseAudienceQuery } from "./metabase.js";
import type { DataAsset } from "../types.js";

function model(id: number, extraColumns: DataAsset["columns"] = []): DataAsset {
  const columns = [
    { name: "uid", type: "type/Text", fieldRef: ["field", { "base-type": "type/Text" }, "uid"] },
    ...extraColumns
  ];
  return {
    id: `metabase:model:${id}`,
    platform: "metabase",
    type: "model",
    title: `Model ${id}`,
    tags: [],
    url: `https://metabase.example/model/${id}`,
    columns,
    audience: {
      entityType: "user",
      identityField: "uid",
      identityType: "type/Text",
      databaseId: 4
    }
  };
}

function collectUuids(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectUuids);
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, item]) =>
    key === "lib/uuid" && typeof item === "string" ? [item] : collectUuids(item)
  );
}

test("builds an audience intersection as governed inner joins and distinct uid count", () => {
  const country = { name: "country", type: "type/Text", fieldRef: ["field", { "base-type": "type/Text" }, "country"] };
  const query = buildMetabaseAudienceQuery([
    { asset: model(101, [country]), filters: [{ field: "country", operator: "eq", value: "CN" }] },
    { asset: model(102, [country]), filters: [{ field: "country", operator: "eq", value: "US" }] },
    { asset: model(103) }
  ], { operator: "intersection", output: "count", limit: 100 });
  const stages = query.stages as Record<string, unknown>[];
  const primaryStage = stages[0];
  const stage = stages[1];
  const joins = stage.joins as Record<string, unknown>[];

  assert.equal(query.database, 4);
  assert.equal(primaryStage["source-card"], 101);
  assert.deepEqual(joins.map((join) => join.strategy), ["inner-join", "inner-join"]);
  assert.deepEqual(joins.map((join) => ((join.stages as Record<string, unknown>[])[0])["source-card"]), [102, 103]);
  assert.equal((stage.aggregation as unknown[][])[0][0], "distinct");
  assert.equal(stage.limit, 1);
  assert.equal((primaryStage.filters as unknown[][]).length, 2);
  assert.equal((primaryStage.breakout as unknown[][])[0][0], "field");

  const firstJoinCondition = (joins[0].conditions as unknown[][])[0];
  assert.equal(firstJoinCondition[0], "=");
  const joinedStage = (joins[0].stages as Record<string, unknown>[])[0];
  assert.equal((joinedStage.filters as unknown[][]).length, 2);
  assert.equal(joins[0]["lib/type"], "mbql/join");
  assert.equal(((joins[0].stages as Record<string, unknown>[])[0])["source-card"], 102);
  const uuids = collectUuids(query);
  assert.equal(new Set(uuids).size, uuids.length);
});

test("builds union with full joins and coalesced uid", () => {
  const query = buildMetabaseAudienceQuery([
    { asset: model(101) },
    { asset: model(102) },
    { asset: model(103) }
  ], { operator: "union", output: "uids", limit: 50 });
  const stage = (query.stages as Record<string, unknown>[])[1];
  const joins = stage.joins as Record<string, unknown>[];

  assert.deepEqual(joins.map((join) => join.strategy), ["full-join", "full-join"]);
  assert.equal(((stage.breakout as unknown[][])[0])[0], "coalesce");
  assert.equal(stage.limit, 51);
  assert.equal(stage.filters, undefined);
});

test("builds difference as left joins followed by joined uid null checks", () => {
  const query = buildMetabaseAudienceQuery([
    { asset: model(101) },
    { asset: model(102) }
  ], { operator: "difference", output: "uids", limit: 25 });
  const stage = (query.stages as Record<string, unknown>[])[1];
  const joins = stage.joins as Record<string, unknown>[];
  const filters = stage.filters as unknown[][];

  assert.equal(joins[0].strategy, "left-join");
  assert.equal(filters.at(-1)?.[0], "is-null");
  assert.equal(stage.limit, 26);
});

test("rejects missing uid metadata and cross-database Models", () => {
  const withoutAudience = { ...model(101), audience: undefined };
  const otherDatabase = { ...model(102), audience: { ...model(102).audience!, databaseId: 5 } };

  assert.throws(
    () => buildMetabaseAudienceQuery([
      { asset: withoutAudience },
      { asset: model(102) }
    ], { operator: "intersection", output: "count", limit: 1 }),
    /audience_uid_missing/
  );
  assert.throws(
    () => buildMetabaseAudienceQuery([
      { asset: model(101) },
      { asset: otherDatabase }
    ], { operator: "intersection", output: "count", limit: 1 }),
    /audience_database_mismatch/
  );
});

test("rejects incompatible uid types", () => {
  const numericUid = {
    ...model(102),
    columns: [{ name: "uid", type: "type/BigInteger", fieldRef: ["field", { "base-type": "type/BigInteger" }, "uid"] }],
    audience: { ...model(102).audience!, identityType: "type/BigInteger" }
  };
  assert.throws(
    () => buildMetabaseAudienceQuery([
      { asset: model(101) },
      { asset: numericUid }
    ], { operator: "intersection", output: "count", limit: 1 }),
    /audience_uid_type_mismatch/
  );
});
