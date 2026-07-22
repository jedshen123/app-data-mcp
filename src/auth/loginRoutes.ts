import type { Express } from "express";
import { getAuthConfig, getHttpConfig } from "../config.js";
import { loginMetabaseUser } from "./metabaseSessions.js";

export function registerLoginRoutes(app: Express) {
  app.get("/auth/metabase/login", (_req, res) => {
    res.type("html").send(renderLoginPage());
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
        .send(renderMessage("登录失败", error instanceof Error ? error.message : String(error)));
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

function renderLoginPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>数据平台授权</title>
  <meta name="description" content="授权 app-data MCP 按照你的数据权限访问数据平台" />
  <style>${pageStyles}</style>
</head>
<body>
  <main class="page-shell page-shell--login">
    <section class="auth-card" aria-labelledby="page-title">
      <div class="form-panel">
        <div class="brand-lockup brand-lockup--light">
          <span class="brand-mark" aria-hidden="true">AD</span>
          <span><strong>app-data</strong><small>团队数据服务</small></span>
        </div>
        <div class="form-heading">
          <span class="section-tag">团队数据服务</span>
          <h1 id="page-title">授权数据平台</h1>
          <p>使用你的数据平台账号完成身份验证</p>
        </div>

        <form id="auth-form" method="post" action="/auth/metabase/login">
          <div class="field">
            <label for="username">数据平台账号</label>
            <div class="input-wrap">
              <span class="input-icon" aria-hidden="true">${iconUser}</span>
              <input id="username" name="username" type="email" autocomplete="username" autocapitalize="none" spellcheck="false" placeholder="name@company.com" required />
            </div>
          </div>
          <div class="field">
            <div class="label-row">
              <label for="password">密码</label>
              <span>与数据平台密码一致</span>
            </div>
            <div class="input-wrap">
              <span class="input-icon" aria-hidden="true">${iconKey}</span>
              <input id="password" name="password" type="password" autocomplete="current-password" placeholder="请输入密码" required />
              <button class="password-toggle" type="button" id="password-toggle" aria-label="显示密码">显示</button>
            </div>
          </div>
          <button class="primary-button" type="submit" id="submit-button">
            <span class="button-label">确认并授权</span>
            <span class="button-arrow" aria-hidden="true">${iconArrow}</span>
          </button>
        </form>

        <div class="security-note">
          <span aria-hidden="true">${iconInfo}</span>
          <p><strong>请注意：</strong>重新授权会生成新的个人 MCP token，当前账号此前生成的 token 将立即失效。</p>
        </div>
        <p class="support-text">遇到授权问题？请联系团队数据平台管理员</p>
      </div>
    </section>
    ${renderFooter()}
  </main>
  <script>
    const form = document.getElementById("auth-form");
    const submitButton = document.getElementById("submit-button");
    const passwordInput = document.getElementById("password");
    const passwordToggle = document.getElementById("password-toggle");

    passwordToggle?.addEventListener("click", () => {
      const showPassword = passwordInput?.getAttribute("type") === "password";
      passwordInput?.setAttribute("type", showPassword ? "text" : "password");
      passwordToggle.textContent = showPassword ? "隐藏" : "显示";
      passwordToggle.setAttribute("aria-label", showPassword ? "隐藏密码" : "显示密码");
    });

    form?.addEventListener("submit", () => {
      submitButton?.setAttribute("disabled", "true");
      const label = submitButton?.querySelector(".button-label");
      if (label) label.textContent = "正在安全连接…";
    });
  </script>
</body>
</html>`;
}

function renderSuccessPage(input: { user: string; mcpToken: string }) {
  const authorizationHeader = `Authorization: Bearer ${input.mcpToken}`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>授权成功</title>
  <style>${pageStyles}</style>
</head>
<body>
  <main class="page-shell page-shell--compact">
    <section class="result-card" aria-labelledby="result-title">
      <div class="result-header result-header--success">
        ${renderBrand()}
        <div class="result-icon" aria-hidden="true">${iconCheckLarge}</div>
        <p class="eyebrow">连接已建立</p>
        <h1 id="result-title">授权成功</h1>
        <p><strong>${escapeHtml(input.user)}</strong> 已通过数据平台身份验证</p>
      </div>
      <div class="result-body">
        <div class="notice notice--warning">
          <span aria-hidden="true">${iconSpark}</span>
          <p><strong>请立即保存下面的 token</strong><br />出于安全考虑，它只会完整展示这一次。该账号之前生成的 token 已失效。</p>
        </div>
        <label class="token-label" for="token">Authorization 请求头</label>
        <div class="token-row">
          <code id="token" tabindex="0">${escapeHtml(authorizationHeader)}</code>
          <button type="button" id="copy-token">${iconCopy}<span>复制 token</span></button>
        </div>
        <p id="copy-status" class="copy-status" aria-live="polite"></p>
        <div class="next-step">
          <span class="step-number">下一步</span>
          <p>将完整内容粘贴到 MCP 客户端的 Authorization 请求头配置中，即可开始使用。</p>
        </div>
        <div class="privacy-line">${iconLock}<span>服务端仅保存 token 哈希，不保存明文 token</span></div>
      </div>
    </section>
    ${renderFooter()}
  </main>
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
        status.textContent = "✓ 已复制到剪贴板";
        button?.classList.add("copied");
        const label = button?.querySelector("span");
        if (label) label.textContent = "已复制";
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
  <style>${pageStyles}</style>
</head>
<body>
  <main class="page-shell page-shell--compact">
    <section class="result-card" aria-labelledby="result-title">
      <div class="result-header result-header--error">
        ${renderBrand()}
        <div class="result-icon" aria-hidden="true">${iconAlert}</div>
        <p class="eyebrow">连接未完成</p>
        <h1 id="result-title">${escapeHtml(title)}</h1>
        <p>数据平台暂时无法完成本次身份验证</p>
      </div>
      <div class="result-body">
        <div class="notice notice--error">
          <span aria-hidden="true">${iconInfo}</span>
          <p><strong>错误详情</strong><br />${escapeHtml(message)}</p>
        </div>
        <a class="primary-button link-button" href="/auth/metabase/login">返回并重新授权 ${iconArrow}</a>
        <p class="support-text">请检查账号和密码；如果问题持续出现，请联系团队数据平台管理员。</p>
      </div>
    </section>
    ${renderFooter()}
  </main>
</body>
</html>`;
}

function renderBrand() {
  return `<div class="brand-lockup"><span class="brand-mark" aria-hidden="true">AD</span><span><strong>app-data</strong><small>团队数据服务</small></span></div>`;
}

function renderFooter() {
  return `<footer><span>app-data MCP</span><span class="footer-dot" aria-hidden="true"></span><span>安全 · 只读 · 权限可控</span></footer>`;
}

const iconLock = `<svg viewBox="0 0 24 24"><rect x="5" y="10" width="14" height="10" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></svg>`;
const iconUser = `<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4" /><path d="M4.5 21a7.5 7.5 0 0 1 15 0" /></svg>`;
const iconKey = `<svg viewBox="0 0 24 24"><circle cx="8" cy="15" r="4" /><path d="m11 12 8-8m-3 3 2 2m-5 1 2 2" /></svg>`;
const iconArrow = `<svg viewBox="0 0 24 24"><path d="M5 12h14m-6-6 6 6-6 6" /></svg>`;
const iconInfo = `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="M12 11v5m0-8h.01" /></svg>`;
const iconCopy = `<svg viewBox="0 0 24 24"><rect x="8" y="8" width="11" height="11" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></svg>`;
const iconCheckLarge = `<svg viewBox="0 0 24 24"><path d="m5 12 4 4L19 6" /></svg>`;
const iconSpark = `<svg viewBox="0 0 24 24"><path d="M12 3v2m0 14v2M3 12h2m14 0h2M5.6 5.6 7 7m10 10 1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4" /><circle cx="12" cy="12" r="4" /></svg>`;
const iconAlert = `<svg viewBox="0 0 24 24"><path d="M12 8v5m0 3h.01" /><circle cx="12" cy="12" r="9" /></svg>`;

const pageStyles = `
  :root { color-scheme: light; --ink: #172033; --muted: #687287; --line: #dfe4ec; --soft: #f5f7fa; --brand: #176b87; --brand-dark: #0c4259; --brand-pale: #eaf5f7; --success: #16805b; --warning: #9a6200; --danger: #b34545; }
  * { box-sizing: border-box; }
  body { margin: 0; min-width: 320px; min-height: 100vh; color: var(--ink); background: #edf1f5; font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; -webkit-font-smoothing: antialiased; }
  body::before { content: ""; position: fixed; inset: 0; pointer-events: none; opacity: .45; background-image: radial-gradient(#b9c6d0 0.65px, transparent 0.65px); background-size: 22px 22px; mask-image: linear-gradient(to bottom, black, transparent 75%); }
  button, input { font: inherit; }
  button, a { -webkit-tap-highlight-color: transparent; }
  svg { width: 1.2em; height: 1.2em; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
  .page-shell { position: relative; z-index: 1; width: min(1080px, calc(100% - 40px)); min-height: 100vh; margin: 0 auto; padding: clamp(36px, 7vh, 76px) 0 24px; display: flex; flex-direction: column; justify-content: center; }
  .page-shell--login { width: min(560px, calc(100% - 40px)); }
  .page-shell--compact { width: min(720px, calc(100% - 40px)); }
  .auth-card, .result-card { overflow: hidden; border: 1px solid rgba(25, 44, 64, .1); border-radius: 24px; background: #fff; box-shadow: 0 24px 70px rgba(30, 48, 65, .12), 0 2px 8px rgba(30, 48, 65, .04); }
  .brand-lockup { position: relative; z-index: 1; display: flex; align-items: center; gap: 12px; }
  .brand-lockup > span:last-child { display: flex; flex-direction: column; gap: 1px; }
  .brand-lockup strong { font-size: 17px; letter-spacing: .01em; }
  .brand-lockup small { color: rgba(255,255,255,.6); font-size: 11px; letter-spacing: .12em; }
  .brand-mark { display: grid; place-items: center; width: 42px; height: 42px; border: 1px solid rgba(255,255,255,.25); border-radius: 12px; background: rgba(255,255,255,.12); color: #fff; font-size: 13px; font-weight: 800; letter-spacing: .08em; }
  .brand-lockup--light { padding-bottom: 28px; border-bottom: 1px solid #edf0f3; }
  .brand-lockup--light small { color: #9299a8; }
  .brand-lockup--light .brand-mark { border-color: #c7d9df; background: var(--brand-pale); color: var(--brand); }
  .eyebrow { margin: 0 0 14px; color: #82d4d8; font-size: 12px; font-weight: 750; letter-spacing: .16em; text-transform: uppercase; }
  .form-panel { padding: 42px 48px 38px; }
  .form-heading { margin: 30px 0 32px; }
  .section-tag { display: inline-flex; margin-bottom: 14px; padding: 6px 10px; border-radius: 99px; background: var(--brand-pale); color: var(--brand); font-size: 11px; font-weight: 750; letter-spacing: .08em; }
  .form-heading h1 { margin: 0; font-size: 30px; letter-spacing: -.025em; }
  .form-heading p { margin: 10px 0 0; color: var(--muted); font-size: 14px; }
  form { display: grid; gap: 22px; }
  .field { display: grid; gap: 9px; }
  label, .label-row label { font-size: 13px; font-weight: 680; }
  .label-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .label-row span { color: #9299a8; font-size: 11px; }
  .input-wrap { position: relative; display: flex; align-items: center; }
  .input-icon { position: absolute; left: 15px; display: grid; color: #8792a5; pointer-events: none; }
  input { width: 100%; height: 50px; padding: 0 50px 0 45px; outline: none; border: 1px solid var(--line); border-radius: 11px; background: #fff; color: var(--ink); font-size: 14px; transition: border-color .18s, box-shadow .18s, background .18s; }
  input::placeholder { color: #a4abb8; }
  input:hover { border-color: #bdc6d3; }
  input:focus { border-color: var(--brand); box-shadow: 0 0 0 4px rgba(23,107,135,.11); }
  .password-toggle { position: absolute; right: 8px; padding: 8px; border: 0; background: transparent; color: var(--brand); font-size: 12px; font-weight: 650; cursor: pointer; }
  .primary-button { width: 100%; min-height: 50px; margin-top: 6px; padding: 0 18px; display: flex; align-items: center; justify-content: center; gap: 10px; border: 0; border-radius: 11px; background: var(--brand); color: #fff; font-size: 14px; font-weight: 720; cursor: pointer; box-shadow: 0 8px 18px rgba(23,107,135,.18); transition: background .18s, transform .18s, box-shadow .18s; }
  .primary-button:hover { background: #115d77; box-shadow: 0 10px 22px rgba(23,107,135,.23); transform: translateY(-1px); }
  .primary-button:active { transform: translateY(0); }
  .primary-button:focus-visible, .token-row button:focus-visible, .link-button:focus-visible { outline: 3px solid rgba(23,107,135,.25); outline-offset: 3px; }
  .primary-button:disabled { opacity: .72; cursor: wait; transform: none; }
  .button-arrow { display: grid; }
  .security-note { display: flex; gap: 10px; margin-top: 24px; padding: 13px 14px; border: 1px solid #e2e8ec; border-radius: 10px; background: #f7f9fa; color: var(--muted); }
  .security-note > span { flex: 0 0 auto; display: grid; margin-top: 1px; color: var(--brand); }
  .security-note p { margin: 0; font-size: 11.5px; line-height: 1.6; }
  .security-note strong { color: #465163; }
  .support-text { margin: 18px 0 0; text-align: center; color: #9098a7; font-size: 11px; }
  footer { display: flex; align-items: center; justify-content: center; gap: 9px; margin-top: 20px; color: #8b94a3; font-size: 11px; letter-spacing: .03em; }
  .footer-dot { width: 3px; height: 3px; border-radius: 50%; background: #aab1bd; }
  .result-card { width: 100%; }
  .result-header { position: relative; overflow: hidden; padding: 34px 48px 38px; color: #fff; background: var(--brand-dark); text-align: center; }
  .result-header::after { content: ""; position: absolute; width: 250px; height: 250px; top: -160px; right: -80px; border: 1px solid rgba(255,255,255,.1); border-radius: 50%; box-shadow: 0 0 0 45px rgba(255,255,255,.025); }
  .result-header .brand-lockup { text-align: left; }
  .result-header .result-icon { display: grid; place-items: center; width: 62px; height: 62px; margin: 24px auto 16px; border: 1px solid rgba(255,255,255,.28); border-radius: 50%; background: rgba(255,255,255,.12); color: #8de2c1; }
  .result-header--error .result-icon { color: #ffc0b9; }
  .result-icon svg { width: 31px; height: 31px; stroke-width: 2.2; }
  .result-header .eyebrow { margin-bottom: 7px; }
  .result-header h1 { margin: 0; font-size: 32px; letter-spacing: -.025em; }
  .result-header > p:last-child { margin: 10px 0 0; color: rgba(255,255,255,.65); font-size: 13px; }
  .result-header > p strong { color: #fff; font-weight: 650; }
  .result-body { padding: 38px 48px 42px; }
  .notice { display: flex; gap: 12px; margin-bottom: 28px; padding: 15px 16px; border: 1px solid #eadfbf; border-radius: 11px; background: #fffaf0; color: #77551d; }
  .notice > span { flex: 0 0 auto; display: grid; margin-top: 2px; color: var(--warning); }
  .notice p { margin: 0; font-size: 12px; line-height: 1.65; }
  .notice strong { color: #62430e; font-size: 13px; }
  .notice--error { border-color: #efd6d6; background: #fff6f5; color: #814d4d; }
  .notice--error > span { color: var(--danger); }
  .notice--error strong { color: #793838; }
  .token-label { display: block; margin-bottom: 9px; }
  .token-row { display: flex; min-width: 0; border: 1px solid var(--line); border-radius: 11px; background: var(--soft); transition: border-color .18s, box-shadow .18s; }
  .token-row:focus-within { border-color: var(--brand); box-shadow: 0 0 0 4px rgba(23,107,135,.09); }
  .token-row code { flex: 1; min-width: 0; overflow-x: auto; padding: 15px 16px; outline: none; color: #39465a; white-space: nowrap; font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace; font-size: 12px; scrollbar-width: thin; }
  .token-row button { flex: 0 0 auto; display: flex; align-items: center; gap: 7px; margin: 5px; padding: 0 13px; border: 0; border-radius: 8px; background: #fff; color: var(--brand); font-size: 12px; font-weight: 700; cursor: pointer; box-shadow: 0 1px 3px rgba(20,40,60,.1); }
  .token-row button.copied { background: #eaf7f1; color: var(--success); }
  .copy-status { min-height: 20px; margin: 8px 0 0; color: var(--success); font-size: 12px; }
  .next-step { display: flex; align-items: flex-start; gap: 12px; margin-top: 14px; padding-top: 22px; border-top: 1px solid #edf0f3; }
  .step-number { flex: 0 0 auto; padding: 4px 8px; border-radius: 6px; background: var(--brand-pale); color: var(--brand); font-size: 10px; font-weight: 760; }
  .next-step p { margin: 0; color: var(--muted); font-size: 12px; line-height: 1.65; }
  .privacy-line { display: flex; align-items: center; justify-content: center; gap: 7px; margin-top: 24px; color: #9199a7; font-size: 11px; }
  .privacy-line svg { width: 14px; height: 14px; }
  .link-button { text-decoration: none; }
  @media (max-width: 820px) {
    .page-shell { width: min(620px, calc(100% - 28px)); padding-top: 22px; }
    .page-shell--login { width: min(560px, calc(100% - 28px)); }
  }
  @media (max-width: 520px) {
    .page-shell, .page-shell--login, .page-shell--compact { width: calc(100% - 20px); padding: 10px 0 18px; justify-content: flex-start; }
    .auth-card, .result-card { border-radius: 17px; }
    .form-panel { padding: 28px 24px 26px; }
    .brand-lockup--light { padding-bottom: 22px; }
    .form-heading { margin: 24px 0 28px; }
    .form-heading h1 { font-size: 26px; }
    .result-header { padding: 24px 22px 30px; }
    .result-body { padding: 28px 22px 32px; }
    .token-row { display: grid; }
    .token-row button { min-height: 42px; justify-content: center; }
    footer { margin-top: 14px; }
  }
  @media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; transition: none !important; } }
`;

function escapeHtml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
