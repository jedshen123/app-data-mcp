#!/usr/bin/env node
import { getPostHogConfig } from "../config.js";
import { upsertPlatformAssets } from "../metadataStore.js";
import { readPostHogAnalysisType } from "../posthogAnalysisType.js";
import type { AssetParameter, DataAsset } from "../types.js";
import { asArray, fetchJson, getNumber, getObject, getString, isObject, joinUrl } from "./http.js";

const config = getPostHogConfig();
type PostHogPage = {
  results?: unknown[];
  next?: string | null;
};

if (!config.baseUrl || !config.projectId || !config.personalApiKey) {
  console.error(
    "PostHog config is incomplete: POSTHOG_BASE_URL, POSTHOG_PROJECT_ID, POSTHOG_PERSONAL_API_KEY are required."
  );
  console.error("POSTHOG_API_KEY is still accepted as a backward-compatible alias.");
  process.exit(1);
}

try {
  const assets = await syncPostHogAssets();
  const result = await upsertPlatformAssets("posthog", assets);
  const dashboardCount = assets.filter((asset) => asset.type === "dashboard").length;
  const insightCount = assets.filter((asset) => asset.type === "insight").length;

  console.log(
    `Synced PostHog metadata to PostgreSQL: ${dashboardCount} dashboards, ${insightCount} insights, ${result.synced} upserted.`
  );
} catch (error) {
  console.error("Failed to sync PostHog metadata:", error);
  process.exit(1);
}

async function syncPostHogAssets(): Promise<DataAsset[]> {
  const [dashboards, insights] = await Promise.all([
    fetchPostHogPages("/dashboards/"),
    fetchPostHogPages("/insights/")
  ]);

  return [...dashboards.map(toDashboardAsset), ...insights.map(toInsightAsset)];
}

async function fetchPostHogPages(pathname: string): Promise<Record<string, unknown>[]> {
  const firstUrl = joinUrl(config.baseUrl!, `/api/projects/${config.projectId}${pathname}`);
  const results: Record<string, unknown>[] = [];
  let nextUrl: string | undefined = firstUrl;

  while (nextUrl) {
    const page: PostHogPage = await fetchJson<PostHogPage>(nextUrl, {
      headers: {
        authorization: `Bearer ${config.personalApiKey}`
      }
    });

    results.push(...asArray<Record<string, unknown>>(page));
    nextUrl = isObject(page) ? getString(page.next) : undefined;
  }

  return results;
}

function toDashboardAsset(dashboard: Record<string, unknown>): DataAsset {
  const id = String(getNumber(dashboard.id) ?? getString(dashboard.id) ?? "");
  const name = getString(dashboard.name) ?? `PostHog dashboard ${id}`;

  return {
    id: `posthog:dashboard:${id}`,
    platform: "posthog",
    type: "dashboard",
    title: name,
    description: getString(dashboard.description),
    businessDomain: "product",
    tags: ["posthog", "dashboard"],
    owner: getUserName(dashboard.created_by),
    url: joinUrl(config.baseUrl!, `/project/${config.projectId}/dashboard/${id}`),
    updatedAt: getString(dashboard.last_modified_at) ?? getString(dashboard.created_at),
    sourceRefs: [
      {
        system: "posthog",
        url: joinUrl(config.baseUrl!, `/project/${config.projectId}/dashboard/${id}`)
      }
    ],
    warnings: ["Synced metadata only. This MCP does not write to PostHog."]
  };
}

function toInsightAsset(insight: Record<string, unknown>): DataAsset {
  const id = String(getString(insight.short_id) ?? getNumber(insight.id) ?? getString(insight.id) ?? "");
  const name = getString(insight.name) ?? getString(insight.derived_name) ?? `PostHog insight ${id}`;
  const filters = getObject(insight.filters);
  const query = getObject(insight.query);

  return {
    id: `posthog:insight:${id}`,
    platform: "posthog",
    type: "insight",
    analysisType: readPostHogAnalysisType(query, filters),
    title: name,
    description: getString(insight.description),
    businessDomain: "product",
    tags: compact(["posthog", "insight", getString(insight.type)]),
    owner: getUserName(insight.created_by),
    url: joinUrl(config.baseUrl!, `/project/${config.projectId}/insights/${id}`),
    updatedAt: getString(insight.last_modified_at) ?? getString(insight.created_at),
    queryText: JSON.stringify(query ?? filters ?? {}, null, 2),
    parameters: readPostHogInsightParameters(filters, query),
    sourceRefs: [
      {
        system: "posthog",
        url: joinUrl(config.baseUrl!, `/project/${config.projectId}/insights/${id}`)
      }
    ],
    warnings: ["Synced metadata only. Query execution remains read-only and row-limited."]
  };
}

function readPostHogInsightParameters(
  filters: Record<string, unknown> | undefined,
  query: Record<string, unknown> | undefined
): AssetParameter[] {
  const parameters: AssetParameter[] = [
    {
      name: "date_from",
      label: "Date from",
      type: "date",
      required: false,
      defaultValue: filters?.date_from ?? query?.dateRange,
      description: "PostHog date_from override, e.g. -30d or 2026-07-01."
    },
    {
      name: "date_to",
      label: "Date to",
      type: "date",
      required: false,
      defaultValue: filters?.date_to,
      description: "PostHog date_to override, e.g. now or 2026-07-09."
    },
    {
      name: "properties",
      label: "Properties",
      type: "unknown",
      required: false,
      defaultValue: filters?.properties,
      description: "PostHog properties filter array. Use the native PostHog property filter shape."
    },
    {
      name: "breakdown",
      label: "Breakdown",
      type: "string",
      required: false,
      defaultValue: filters?.breakdown,
      description: "PostHog breakdown override when supported by the saved insight type."
    }
  ];

  return parameters;
}

function getUserName(value: unknown): string | undefined {
  const user = getObject(value);
  return getString(user?.distinct_id) ?? getString(user?.email) ?? getString(user?.first_name);
}

function compact(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value))));
}
