import type { DataAsset } from "./types.js";

export type SqlQueryPurpose = "data_question" | "metadata_inspection" | "user_requested_sql";

export type SqlGovernanceInput = {
  sql: string;
  purpose: SqlQueryPurpose;
  rejectedAssetIds?: string[];
  fallbackReason?: string;
};

export type SqlGovernanceDecision = {
  allowed: boolean;
  code?: string;
  message?: string;
  candidates: DataAsset[];
};

export function evaluateSqlGovernance(candidates: DataAsset[], input: SqlGovernanceInput): SqlGovernanceDecision {
  const rejected = new Set(input.rejectedAssetIds ?? []);
  if (rejected.size > 0 && !input.fallbackReason?.trim()) {
    return {
      allowed: false,
      code: "fallback_reason_required",
      message: "说明候选治理资产不适用的原因后，才能回退到 SQL。",
      candidates: candidates.filter((asset) => rejected.has(asset.id))
    };
  }

  if (input.purpose === "user_requested_sql") return { allowed: true, candidates: [] };
  if (input.purpose === "metadata_inspection") {
    if (/^\s*(show|desc|describe|explain)\b/i.test(input.sql)) return { allowed: true, candidates: [] };
    return {
      allowed: false,
      code: "metadata_inspection_requires_metadata_sql",
      message: "metadata_inspection 只允许 SHOW、DESCRIBE、DESC 或 EXPLAIN。普通数据查询必须先检查治理资产。",
      candidates: []
    };
  }

  const remaining = candidates.filter((asset) => !rejected.has(asset.id));
  if (remaining.length > 0) {
    return {
      allowed: false,
      code: "governed_assets_available",
      message: "发现可回答该问题的已开放治理资产。请先调用 get_asset 检查字段和指标定义，再使用 run_asset；不要直接执行 SQL。",
      candidates: remaining
    };
  }
  return { allowed: true, candidates: [] };
}
