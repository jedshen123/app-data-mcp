import assert from "node:assert/strict";
import test from "node:test";
import { indexMetabaseCollections, resolveMetabaseCollectionName } from "./metabaseCollections.js";

test("resolves a collection name from collection_id", () => {
  const collections = indexMetabaseCollections([
    { id: 21, name: "增长分析" },
    { id: 22, name: "设备业务" }
  ]);

  assert.equal(resolveMetabaseCollectionName({ collection_id: 21 }, collections), "增长分析");
});

test("prefers an embedded collection name", () => {
  const collections = indexMetabaseCollections([{ id: 21, name: "旧名称" }]);

  assert.equal(
    resolveMetabaseCollectionName({ collection_id: 21, collection: { id: 21, name: "新名称" } }, collections),
    "新名称"
  );
});
