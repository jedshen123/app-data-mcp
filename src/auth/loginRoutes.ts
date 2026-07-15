import type { Express } from "express";
import { getAuthConfig, getHttpConfig } from "../config.js";
import { loginMetabaseUser } from "./metabaseSessions.js";

export function registerLoginRoutes(app: Express) {
  app.get("/auth/metabase/login", (_req, res) => {
    const { metabaseSessionTtlHours } = getAuthConfig();
    res.type("html").send(renderLoginPage({ metabaseSessionTtlHours }));
  });

  app.post("/auth/metabase/login", async (req, res) => {
    const username = typeof req.body?.username === "string" ? req.body.username.trim() : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";

    if (!username || !password) {
      res.status(400).type("html").send(renderMessage("登录失败", "请输入数据平台的账号和密码。"));
      return;
    }

    try {
      const session = await loginMetabaseUser(username, password);
      res.type("html").send(renderSuccessPage(session));
    } catch (error) {
      res
        .status(401)
        .type("html")
        .send(renderMessage("登录失败", escapeHtml(error instanceof Error ? error.message : String(error))));
    }
  });
}

export function getMetabaseLoginUrl(): string {
  const auth = getAuthConfig();
  const base = auth.publicBaseUrl?.replace(/\/$/, "");
  if (base) return `${base}/auth/metabase/login`;

  const { host, port } = getHttpConfig();
  const displayHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  return `http://${displayHost}:${port}/auth/metabase/login`;
}

function renderLoginPage(input: { metabaseSessionTtlHours: number }) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>数据平台授权</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 40px; max-width: 520px; color: #202124; }
    label { display: block; margin: 14px 0 6px; font-weight: 600; }
    input { box-sizing: border-box; width: 100%; padding: 10px 12px; border: 1px solid #c9ced6; border-radius: 6px; font-size: 14px; }
    button { margin-top: 18px; padding: 10px 14px; border: 0; border-radius: 6px; background: #1a73e8; color: white; font-weight: 700; cursor: pointer; }
    p { line-height: 1.55; }
    .hint { color: #5f6368; font-size: 13px; }
    code { background: #f1f3f4; padding: 2px 4px; border-radius: 4px; }
    pre { overflow-x: auto; background: #f1f3f4; padding: 12px; border-radius: 6px; }
    pre code { padding: 0; }
  </style>
</head>
<body>
  <h1>授权 app-data MCP 访问数据平台</h1>
  <p>请输入数据平台的账号和密码。授权后，MCP 将按你的数据权限提供只读查询服务。</p>
  <form method="post" action="/auth/metabase/login">
    <label for="username">账号</label>
    <input id="username" name="username" type="email" autocomplete="username" required />
    <label for="password">密码</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required />
    <button type="submit">授权</button>
  </form>
  <p class="hint">不会保存你的密码；仅保存登录会话和个人 MCP token 的哈希。默认有效期 ${input.metabaseSessionTtlHours} 小时。</p>
</body>
</html>`;
}

function renderSuccessPage(input: { user: string; expiresAt: string; mcpToken: string }) {
  const authorizationHeader = `Authorization: Bearer ${input.mcpToken}`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>授权成功</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 40px; max-width: 720px; color: #202124; }
    p { line-height: 1.55; }
    .token-row { display: flex; align-items: stretch; max-width: 100%; margin-top: 16px; }
    code { flex: 1; overflow-x: auto; white-space: nowrap; background: #f1f3f4; padding: 12px; border: 1px solid #e0e3e7; border-right: 0; border-radius: 6px 0 0 6px; font-size: 13px; }
    button { padding: 0 14px; border: 1px solid #1a73e8; border-radius: 0 6px 6px 0; background: #1a73e8; color: white; font-weight: 700; cursor: pointer; }
    .status { min-height: 20px; margin-top: 10px; color: #137333; font-size: 13px; }
    .hint { color: #5f6368; font-size: 13px; }
  </style>
</head>
<body>
  <h1>授权成功</h1>
  <p>已为 ${escapeHtml(input.user)} 保存数据平台登录会话，有效期至 ${escapeHtml(input.expiresAt)}。请把下面的个人 MCP token 配到你的 AI 助手中；token 只展示这一次。</p>
  <div class="token-row">
    <code id="token">${escapeHtml(authorizationHeader)}</code>
    <button type="button" id="copy-token">复制</button>
  </div>
  <p id="copy-status" class="status" aria-live="polite"></p>
  <p class="hint">服务端只保存 token 哈希，不保存明文 token。</p>
  <script>
    const tokenText = ${JSON.stringify(authorizationHeader)};
    const button = document.getElementById("copy-token");
    const status = document.getElementById("copy-status");
    button?.addEventListener("click", async () => {
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(tokenText);
        } else {
          const textarea = document.createElement("textarea");
          textarea.value = tokenText;
          textarea.style.position = "fixed";
          textarea.style.left = "-9999px";
          document.body.appendChild(textarea);
          textarea.focus();
          textarea.select();
          document.execCommand("copy");
          textarea.remove();
        }
        status.textContent = "已复制";
      } catch {
        status.textContent = "复制失败，请手动选中 token";
      }
    });
  </script>
</body>
</html>`;
}

function renderMessage(title: string, message: string) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 40px; max-width: 560px; color: #202124; }
    p { line-height: 1.55; }
    pre { overflow-x: auto; background: #f1f3f4; padding: 12px; border-radius: 6px; }
  </style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <p>${message}</p>
</body>
</html>`;
}

function escapeHtml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
