import { createHash, randomBytes } from "node:crypto";
import type { Request, Response } from "express";
import { getAuthConfig, getMetabaseConfig } from "../config.js";
import { getMetadataPool, qualifiedName, quoteIdentifier } from "../metadataStore.js";
import { fetchJson, joinUrl } from "../sync/http.js";

const ADMIN_COOKIE = "app_data_admin";
const PERSISTENT_COOKIE_MAX_AGE_MS = 400 * 24 * 60 * 60 * 1000;

type AdminSession = {
  token: string;
  csrfToken: string;
  user: string;
  expiresAt: number | null;
};

let initialized = false;
let initializationPromise: Promise<void> | undefined;

export async function loginAdmin(username: string, password: string): Promise<AdminSession> {
  const config = getMetabaseConfig();
  if (!config.baseUrl) throw new Error("METABASE_BASE_URL is required for administrator login.");
  const login = await fetchJson<{ id: string }>(joinUrl(config.baseUrl, "/api/session"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password })
  });
  const currentUser = await fetchJson<Record<string, unknown>>(joinUrl(config.baseUrl, "/api/user/current"), {
    headers: { "X-Metabase-Session": login.id }
  });
  if (currentUser.is_superuser !== true) {
    throw new Error("当前 Metabase 账号不是管理员，不能登录 MCP 后台。");
  }
  const user = readUserEmail(currentUser) ?? username;
  const token = randomBytes(32).toString("base64url");
  const session: AdminSession = {
    token,
    csrfToken: randomBytes(24).toString("base64url"),
    user,
    expiresAt: getAuthConfig().adminSessionPersistent
      ? null
      : Date.now() + getAuthConfig().adminSessionTtlHours * 60 * 60 * 1000
  };
  await saveAdminSession(session);
  return session;
}

export function setAdminCookie(req: Request, res: Response, session: AdminSession): void {
  res.cookie(ADMIN_COOKIE, session.token, {
    httpOnly: true,
    sameSite: "strict",
    secure: req.secure || req.header("x-forwarded-proto") === "https",
    path: "/admin",
    maxAge: session.expiresAt === null
      ? PERSISTENT_COOKIE_MAX_AGE_MS
      : Math.max(session.expiresAt - Date.now(), 0)
  });
}

export async function clearAdminSession(req: Request, res: Response): Promise<void> {
  const token = readCookie(req, ADMIN_COOKIE);
  if (token) {
    await ensureAdminSessionTable();
    const pool = await getMetadataPool();
    const config = getAuthConfig();
    await pool.query(
      `delete from ${qualifiedName(process.env.DB_SCHEMA ?? "public", config.adminSessionTable)} where token_hash = $1`,
      [hashToken(token)]
    );
  }
  res.clearCookie(ADMIN_COOKIE, { path: "/admin" });
}

export async function getAdminSession(req: Request): Promise<AdminSession | undefined> {
  const token = readCookie(req, ADMIN_COOKIE);
  if (!token) return undefined;
  await ensureAdminSessionTable();
  const pool = await getMetadataPool();
  const config = getAuthConfig();
  const result = await pool.query<{ user_email: string; csrf_token: string; expires_at: Date | null }>(
    `select user_email, csrf_token, expires_at
     from ${qualifiedName(process.env.DB_SCHEMA ?? "public", config.adminSessionTable)}
     where token_hash = $1 and (expires_at is null or expires_at > now())`,
    [hashToken(token)]
  );
  const row = result.rows[0];
  if (!row) return undefined;
  return {
    token,
    csrfToken: row.csrf_token,
    user: row.user_email,
    expiresAt: row.expires_at?.getTime() ?? null
  };
}

export function hasValidCsrf(req: Request, session: AdminSession): boolean {
  return req.header("x-csrf-token") === session.csrfToken;
}

function readCookie(req: Request, name: string): string | undefined {
  const cookies = req.header("cookie")?.split(";") ?? [];
  for (const cookie of cookies) {
    const [key, ...parts] = cookie.trim().split("=");
    if (key === name) return decodeURIComponent(parts.join("="));
  }
  return undefined;
}

function readUserEmail(user: Record<string, unknown>): string | undefined {
  return typeof user.email === "string" && user.email.trim() ? user.email.trim() : undefined;
}

async function saveAdminSession(session: AdminSession): Promise<void> {
  await ensureAdminSessionTable();
  const pool = await getMetadataPool();
  const config = getAuthConfig();
  await pool.query(
    `insert into ${qualifiedName(process.env.DB_SCHEMA ?? "public", config.adminSessionTable)}
       (token_hash, user_email, csrf_token, created_at, expires_at)
     values ($1, $2, $3, now(), $4)`,
    [hashToken(session.token), session.user, session.csrfToken, session.expiresAt === null ? null : new Date(session.expiresAt)]
  );
}

export async function ensureAdminSessionTable(): Promise<void> {
  if (initialized) return;
  initializationPromise ??= initializeAdminSessionTable().catch((error) => {
    initializationPromise = undefined;
    throw error;
  });
  await initializationPromise;
  initialized = true;
}

async function initializeAdminSessionTable(): Promise<void> {
  const pool = await getMetadataPool();
  const connection = await pool.connect();
  const config = getAuthConfig();
  const schema = process.env.DB_SCHEMA ?? "public";
  const tableName = qualifiedName(schema, config.adminSessionTable);
  try {
    await connection.query("begin");
    await connection.query("select pg_advisory_xact_lock(hashtext($1))", [`app-data-mcp-admin-sessions:${tableName}`]);
    await connection.query(`create table if not exists ${tableName} (
      token_hash text primary key,
      user_email text not null,
      csrf_token text not null,
      created_at timestamptz not null default now(),
      expires_at timestamptz
    )`);
    await connection.query(`alter table ${tableName} alter column expires_at drop not null`);
    await connection.query(`create index if not exists ${quoteIdentifier(`${config.adminSessionTable}_user_idx`)} on ${tableName} (user_email, expires_at desc)`);
    await connection.query(`create index if not exists ${quoteIdentifier(`${config.adminSessionTable}_expires_idx`)} on ${tableName} (expires_at)`);
    await connection.query(`delete from ${tableName} where expires_at is not null and expires_at <= now()`);
    if (config.adminSessionPersistent) {
      await connection.query(`update ${tableName} set expires_at = null where expires_at is not null`);
    }
    await connection.query("commit");
  } catch (error) {
    await connection.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    connection.release();
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
