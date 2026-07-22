import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getStoredMetabaseSessionStatus, getUserForMcpToken, loginMetabaseUser } from "./metabaseSessions.js";

test("only the latest legacy MCP token remains active and ignores local session expiry", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "app-data-mcp-auth-"));
  const sessionFile = path.join(directory, "sessions.json");
  const previousSessionFile = process.env.APP_DATA_SESSION_FILE;
  process.env.APP_DATA_SESSION_FILE = sessionFile;

  context.after(async () => {
    if (previousSessionFile === undefined) delete process.env.APP_DATA_SESSION_FILE;
    else process.env.APP_DATA_SESSION_FILE = previousSessionFile;
    await fs.rm(directory, { recursive: true, force: true });
  });

  const legacyToken = "appdata_legacy";
  const currentToken = "appdata_current";
  await fs.writeFile(
    sessionFile,
    JSON.stringify({
      version: 2,
      sessions: {
        "user@example.com": {
          user: "user@example.com",
          session: "expired-platform-session",
          mcpTokenHash: hashToken(legacyToken),
          mcpTokenHashes: [hashToken(currentToken)],
          createdAt: "2026-01-01T00:00:00.000Z",
          expiresAt: "2026-01-02T00:00:00.000Z"
        }
      }
    }),
    "utf8"
  );

  assert.equal(await getUserForMcpToken(legacyToken), undefined);
  assert.equal(await getUserForMcpToken(currentToken), "user@example.com");
  assert.equal(await getUserForMcpToken("appdata_unknown"), undefined);
  const oldSessionStatus = await getStoredMetabaseSessionStatus("user@example.com");
  assert.equal(oldSessionStatus.authorized, true);
  if (oldSessionStatus.authorized) assert.equal(oldSessionStatus.session, "expired-platform-session");

  await fs.writeFile(
    sessionFile,
    JSON.stringify({
      version: 2,
      sessions: {
        "user@example.com": {
          user: "user@example.com",
          session: "new-platform-session",
          mcpTokenHashes: [hashToken(currentToken)],
          createdAt: "2026-07-15T00:00:00.000Z",
          expiresAt: "2026-07-22T00:00:00.000Z"
        }
      }
    }),
    "utf8"
  );

  assert.equal(await getUserForMcpToken(legacyToken), undefined);
  assert.equal(await getUserForMcpToken(currentToken), "user@example.com");
});

test("reauthorizing an account invalidates its previously issued MCP token", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "app-data-mcp-auth-"));
  const sessionFile = path.join(directory, "sessions.json");
  const previousSessionFile = process.env.APP_DATA_SESSION_FILE;
  const previousBaseUrl = process.env.METABASE_BASE_URL;
  const previousFetch = globalThis.fetch;
  let loginCount = 0;
  globalThis.fetch = async () => {
    loginCount += 1;
    return Response.json({ id: `platform-session-${loginCount}` });
  };
  process.env.APP_DATA_SESSION_FILE = sessionFile;
  process.env.METABASE_BASE_URL = "http://metabase.test";

  context.after(async () => {
    if (previousSessionFile === undefined) delete process.env.APP_DATA_SESSION_FILE;
    else process.env.APP_DATA_SESSION_FILE = previousSessionFile;
    if (previousBaseUrl === undefined) delete process.env.METABASE_BASE_URL;
    else process.env.METABASE_BASE_URL = previousBaseUrl;
    globalThis.fetch = previousFetch;
    await fs.rm(directory, { recursive: true, force: true });
  });

  const firstLogin = await loginMetabaseUser("User@Example.com", "password");
  assert.equal(await getUserForMcpToken(firstLogin.mcpToken), "User@Example.com");

  const secondLogin = await loginMetabaseUser("user@example.com", "password");
  assert.equal(await getUserForMcpToken(firstLogin.mcpToken), undefined);
  assert.equal(await getUserForMcpToken(secondLogin.mcpToken), "user@example.com");

  const stored = JSON.parse(await fs.readFile(sessionFile, "utf8")) as {
    sessions: Record<string, { mcpTokenHash?: string; mcpTokenHashes?: string[]; session: string }>;
  };
  assert.equal(stored.sessions["user@example.com"].mcpTokenHash, hashToken(secondLogin.mcpToken));
  assert.equal(stored.sessions["user@example.com"].mcpTokenHashes, undefined);
  assert.equal(stored.sessions["user@example.com"].session, "platform-session-2");
});

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
