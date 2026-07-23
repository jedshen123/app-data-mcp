import assert from "node:assert/strict";
import test from "node:test";
import { filterAssetsByLiveAccess } from "./accessPolicy.js";
import { withRequestContext } from "./requestContext.js";
import type { DataAsset } from "./types.js";

const assets: DataAsset[] = [
  {
    id: "metabase:dashboard:1",
    platform: "metabase",
    type: "dashboard",
    title: "Visible",
    tags: [],
    url: "https://metabase.example/dashboard/1"
  },
  {
    id: "metabase:dashboard:2",
    platform: "metabase",
    type: "dashboard",
    title: "Hidden",
    tags: [],
    url: "https://metabase.example/dashboard/2"
  },
  {
    id: "posthog:dashboard:3",
    platform: "posthog",
    type: "dashboard",
    title: "PostHog",
    tags: [],
    url: "https://posthog.example/dashboard/3"
  }
];

test("filters Metabase search candidates with the current user's live session", async () => {
  const originalBaseUrl = process.env.METABASE_BASE_URL;
  const originalFetch = globalThis.fetch;
  process.env.METABASE_BASE_URL = "https://metabase.example";
  globalThis.fetch = (async (input) => {
    const url = String(input);
    return new Response(url.endsWith("/api/dashboard/1") ? "{}" : "forbidden", {
      status: url.endsWith("/api/dashboard/1") ? 200 : 403,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;

  try {
    const visible = await withRequestContext(
      { user: "user@example.com", groups: [], metabaseSession: "personal-session" },
      () => filterAssetsByLiveAccess(assets)
    );
    assert.deepEqual(visible.map((asset) => asset.id), [
      "metabase:dashboard:1",
      "posthog:dashboard:3"
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalBaseUrl === undefined) delete process.env.METABASE_BASE_URL;
    else process.env.METABASE_BASE_URL = originalBaseUrl;
  }
});
