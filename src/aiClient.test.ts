import assert from "node:assert/strict";
import test from "node:test";
import {
  identifyAiClient,
  identifyAiClientVersion,
  resolveAuditAiClient,
  resolveAuditAiClientVersion
} from "./aiClient.js";

test("prefers an explicit client header", () => {
  assert.equal(identifyAiClient("custom-agent", "WorkBuddy/5.3.3"), "custom-agent");
});

test("recognizes common AI and MCP clients from user agent", () => {
  const cases: Array<[string, string]> = [
    ["WorkBuddy/5.3.3", "workbuddy"],
    ["claude-code/1.0", "claude-code"],
    ["Claude Desktop/0.12", "claude-desktop"],
    ["codex-cli/1.2", "codex"],
    ["Cursor/0.50", "cursor"],
    ["Windsurf/1.0", "windsurf"],
    ["Roo-Code/3.0", "roo-code"],
    ["Cline/3.12", "cline"],
    ["GitHub-Copilot/1.0", "github-copilot"],
    ["Gemini-CLI/0.1", "gemini-cli"],
    ["MCP-Inspector/0.16", "mcp-inspector"],
    ["CherryStudio/1.5", "cherry-studio"],
    ["Open-WebUI/0.6", "open-webui"]
  ];

  for (const [userAgent, expected] of cases) {
    assert.equal(identifyAiClient(undefined, userAgent), expected, userAgent);
  }
});

test("uses a recognizable generic product name before unknown", () => {
  assert.equal(identifyAiClient(undefined, "Acme-MCP/2.4.1 (darwin)"), "acme-mcp");
  assert.equal(identifyAiClient(undefined, "undici"), "node-http");
  assert.equal(identifyAiClient(undefined, undefined), "unknown");
});

test("repairs historical unknown values from user agent", () => {
  assert.equal(resolveAuditAiClient("unknown", "WorkBuddy/5.2.6"), "workbuddy");
  assert.equal(resolveAuditAiClient("cursor", "WorkBuddy/5.2.6"), "cursor");
});

test("extracts explicit and user-agent client versions", () => {
  assert.equal(identifyAiClientVersion("6.0.0", "WorkBuddy/5.3.3", "workbuddy"), "6.0.0");
  assert.equal(identifyAiClientVersion(undefined, "WorkBuddy/5.3.3", "workbuddy"), "5.3.3");
  assert.equal(identifyAiClientVersion(undefined, "codex-cli/1.2.4", "codex"), "1.2.4");
  assert.equal(identifyAiClientVersion(undefined, "Mozilla/5.0 Chrome/130.0.1", "browser"), "130.0.1");
  assert.equal(identifyAiClientVersion(undefined, undefined, "workbuddy"), undefined);
});

test("repairs historical missing versions from user agent", () => {
  assert.equal(resolveAuditAiClientVersion(undefined, "WorkBuddy/5.2.6", "workbuddy"), "5.2.6");
  assert.equal(resolveAuditAiClientVersion("5.3.3", "WorkBuddy/5.2.6", "workbuddy"), "5.3.3");
});
