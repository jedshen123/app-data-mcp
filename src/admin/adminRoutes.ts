import type { Express, NextFunction, Request, Response } from "express";
import {
  bulkUpdateManagedAssets,
  listAuditLogs,
  listManagedAssetDomains,
  listManagedAssetTypes,
  listManagedAssets,
  updateManagedAsset,
  type ManagedAssetPatch,
  type ManagedAssetSort
} from "../metadataStore.js";
import type { DataAssetType, DataPlatform } from "../types.js";
import {
  buildEffectiveInstructions,
  getGlobalInstructions,
  listManagedTools,
  updateGlobalInstructions,
  updateManagedTool
} from "../toolStore.js";
import { clearAdminSession, getAdminSession, hasValidCsrf, loginAdmin, setAdminCookie } from "./adminAuth.js";
import { renderAdminPage } from "./adminPage.js";

export function registerAdminRoutes(app: Express): void {
  app.get("/admin", (_req, res) => res.type("html").send(renderAdminPage()));

  app.post("/admin/api/login", async (req, res) => {
    const username = readString(req.body?.username);
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (!username || !password) {
      res.status(400).json({ error: "请输入 Metabase 账号和密码。" });
      return;
    }
    try {
      const session = await loginAdmin(username, password);
      setAdminCookie(req, res, session);
      res.json({
        user: session.user,
        csrfToken: session.csrfToken,
        expiresAt: session.expiresAt === null ? null : new Date(session.expiresAt).toISOString(),
        persistent: session.expiresAt === null
      });
    } catch (error) {
      res.status(401).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/admin/api/session", requireAdmin, async (req, res) => {
    const session = (await getAdminSession(req))!;
    res.json({
      user: session.user,
      csrfToken: session.csrfToken,
      expiresAt: session.expiresAt === null ? null : new Date(session.expiresAt).toISOString(),
      persistent: session.expiresAt === null
    });
  });

  app.post("/admin/api/logout", requireAdminMutation, async (req, res) => {
    await clearAdminSession(req, res);
    res.json({ ok: true });
  });

  app.get("/admin/api/assets", requireAdmin, async (req, res) => {
    try {
      const platform = readPlatform(req.query.platform);
      const published = readOptionalBoolean(req.query.published);
      const result = await listManagedAssets({
        platform,
        assetType: readAssetType(req.query.type),
        businessDomain: readString(req.query.businessDomain),
        query: readString(req.query.query),
        published,
        limit: readInteger(req.query.limit),
        offset: readInteger(req.query.offset),
        sort: readAssetSort(req.query.sort),
        order: req.query.order === "asc" ? "asc" : "desc"
      });
      res.json(result);
    } catch (error) {
      sendServerError(res, error);
    }
  });

  app.get("/admin/api/domains", requireAdmin, async (req, res) => {
    try {
      const domains = await listManagedAssetDomains(readPlatform(req.query.platform));
      res.json({ domains });
    } catch (error) {
      sendServerError(res, error);
    }
  });

  app.get("/admin/api/types", requireAdmin, async (req, res) => {
    try {
      const types = await listManagedAssetTypes(readPlatform(req.query.platform));
      res.json({ types });
    } catch (error) {
      sendServerError(res, error);
    }
  });

  app.patch("/admin/api/assets", requireAdminMutation, async (req, res) => {
    try {
      const input = readBulkPublishPatch(req.body);
      const updated = await bulkUpdateManagedAssets(input.assetIds, input.published);
      res.json({ updated });
    } catch (error) {
      if (error instanceof InputError) res.status(400).json({ error: error.message });
      else sendServerError(res, error);
    }
  });

  app.patch("/admin/api/assets/:assetId", requireAdminMutation, async (req, res) => {
    try {
      const assetId = readString(req.params.assetId);
      if (!assetId) throw new InputError("资产 ID 无效。");
      const patch = readAssetPatch(req.body);
      const updated = await updateManagedAsset(assetId, patch);
      if (!updated) {
        res.status(404).json({ error: "元信息不存在。" });
        return;
      }
      res.json(updated);
    } catch (error) {
      if (error instanceof InputError) res.status(400).json({ error: error.message });
      else sendServerError(res, error);
    }
  });

  app.get("/admin/api/audit", requireAdmin, async (req, res) => {
    try {
      const result = await listAuditLogs({
        user: readString(req.query.user),
        tool: readString(req.query.tool),
        status: readString(req.query.status),
        limit: readInteger(req.query.limit),
        offset: readInteger(req.query.offset)
      });
      res.json(result);
    } catch (error) {
      sendServerError(res, error);
    }
  });

  app.get("/admin/api/tools", requireAdmin, async (_req, res) => {
    try {
      const [tools, globalInstructions] = await Promise.all([listManagedTools(), getGlobalInstructions()]);
      res.json({ tools, globalInstructions, effectiveInstructions: buildEffectiveInstructions(globalInstructions, tools) });
    } catch (error) {
      sendServerError(res, error);
    }
  });

  app.patch("/admin/api/tools/:toolName", requireAdminMutation, async (req, res) => {
    try {
      const toolName = readString(req.params.toolName);
      if (!toolName) throw new InputError("工具名称无效。");
      if (typeof req.body?.enabled !== "boolean") throw new InputError("enabled 必须是布尔值。");
      const admin = (await getAdminSession(req))!;
      const tool = await updateManagedTool(toolName, req.body.enabled, admin.user);
      if (!tool) {
        res.status(404).json({ error: "MCP 工具不存在。" });
        return;
      }
      res.json(tool);
    } catch (error) {
      if (error instanceof InputError) res.status(400).json({ error: error.message });
      else sendServerError(res, error);
    }
  });

  app.patch("/admin/api/tool-settings", requireAdminMutation, async (req, res) => {
    try {
      const globalInstructions = readString(req.body?.globalInstructions);
      if (!globalInstructions) throw new InputError("全局说明不能为空。");
      if (globalInstructions.length > 20_000) throw new InputError("全局说明不能超过 20000 个字符。");
      const admin = (await getAdminSession(req))!;
      const saved = await updateGlobalInstructions(globalInstructions, admin.user);
      const tools = await listManagedTools();
      res.json({
        globalInstructions: saved,
        effectiveInstructions: buildEffectiveInstructions(saved, tools)
      });
    } catch (error) {
      if (error instanceof InputError) res.status(400).json({ error: error.message });
      else sendServerError(res, error);
    }
  });
}

async function requireAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  const session = await getAdminSession(req);
  if (!session) {
    res.status(401).json({ error: "管理员登录已失效，请重新登录。" });
    return;
  }
  setAdminCookie(req, res, session);
  next();
}

async function requireAdminMutation(req: Request, res: Response, next: NextFunction): Promise<void> {
  const session = await getAdminSession(req);
  if (!session) {
    res.status(401).json({ error: "管理员登录已失效，请重新登录。" });
    return;
  }
  if (!hasValidCsrf(req, session)) {
    res.status(403).json({ error: "无效的后台操作令牌。" });
    return;
  }
  setAdminCookie(req, res, session);
  next();
}

function readAssetPatch(value: unknown): ManagedAssetPatch {
  if (!value || typeof value !== "object") throw new InputError("请求内容无效。");
  const input = value as Record<string, unknown>;
  const patch: ManagedAssetPatch = {};
  if (input.published !== undefined) {
    if (typeof input.published !== "boolean") throw new InputError("published 必须是布尔值。");
    patch.published = input.published;
  }
  if (input.title !== undefined) {
    if (typeof input.title !== "string" || !input.title.trim()) throw new InputError("标题不能为空。");
    patch.title = input.title.trim().slice(0, 500);
  }
  if (input.description !== undefined) patch.description = readNullableString(input.description, "描述");
  if (input.businessDomain !== undefined) patch.businessDomain = readNullableString(input.businessDomain, "业务域");
  if (input.tags !== undefined) {
    if (!Array.isArray(input.tags) || input.tags.some((item) => typeof item !== "string")) throw new InputError("标签格式无效。");
    patch.tags = Array.from(new Set(input.tags.map((item) => (item as string).trim()).filter(Boolean))).slice(0, 100);
  }
  return patch;
}

function readBulkPublishPatch(value: unknown): { assetIds: string[]; published: boolean } {
  if (!value || typeof value !== "object") throw new InputError("请求内容无效。");
  const input = value as Record<string, unknown>;
  if (!Array.isArray(input.assetIds) || input.assetIds.some((item) => typeof item !== "string")) {
    throw new InputError("assetIds 格式无效。");
  }
  const assetIds = Array.from(new Set(input.assetIds.map((item) => (item as string).trim()).filter(Boolean)));
  if (!assetIds.length) throw new InputError("请至少选择一条元信息。");
  if (assetIds.length > 500) throw new InputError("单次最多操作 500 条元信息。");
  if (typeof input.published !== "boolean") throw new InputError("published 必须是布尔值。");
  return { assetIds, published: input.published };
}

function readNullableString(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new InputError(`${label}格式无效。`);
  return value.trim() ? value.trim().slice(0, 5000) : null;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readInteger(value: unknown): number | undefined {
  const raw = readString(value);
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function readPlatform(value: unknown): DataPlatform | undefined {
  return value === "metabase" || value === "posthog" || value === "local" ? value : undefined;
}

function readAssetType(value: unknown): DataAssetType | undefined {
  const allowed: DataAssetType[] = ["dashboard", "card", "model", "insight", "metric", "table", "event"];
  return typeof value === "string" && allowed.includes(value as DataAssetType)
    ? value as DataAssetType
    : undefined;
}

function readAssetSort(value: unknown): ManagedAssetSort | undefined {
  const allowed: ManagedAssetSort[] = [
    "asset_id", "title", "type", "business_domain", "published", "active", "last_synced_at", "updated_at"
  ];
  return typeof value === "string" && allowed.includes(value as ManagedAssetSort)
    ? value as ManagedAssetSort
    : undefined;
}

function readOptionalBoolean(value: unknown): boolean | undefined {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function sendServerError(res: Response, error: unknown): void {
  console.error("Admin API error:", error);
  res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
}

class InputError extends Error {}
