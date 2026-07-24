const POSTHOG_ANALYSIS_TYPES: Record<string, string> = {
  TrendsQuery: "trends",
  FunnelsQuery: "funnels",
  RetentionQuery: "retention",
  PathsQuery: "paths",
  StickinessQuery: "stickiness",
  LifecycleQuery: "lifecycle",
  HogQLQuery: "sql",
  DataTableNode: "table",
  EventsQuery: "events"
};

export function readPostHogAnalysisType(
  query: Record<string, unknown> | undefined,
  filters?: Record<string, unknown>
): string | undefined {
  const queryKind = readKind(query?.source) ?? readKind(query);
  if (queryKind && POSTHOG_ANALYSIS_TYPES[queryKind]) {
    return POSTHOG_ANALYSIS_TYPES[queryKind];
  }

  const legacyInsight = typeof filters?.insight === "string" ? filters.insight : undefined;
  if (!legacyInsight) return undefined;
  return {
    TRENDS: "trends",
    FUNNELS: "funnels",
    RETENTION: "retention",
    PATHS: "paths",
    STICKINESS: "stickiness",
    LIFECYCLE: "lifecycle"
  }[legacyInsight.toUpperCase()];
}

function readKind(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const kind = (value as Record<string, unknown>).kind;
  return typeof kind === "string" ? kind : undefined;
}
