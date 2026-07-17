import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getStoredMetabaseSessionStatus, getUserForMcpToken } from "./metabaseSessions.js";

test("personal MCP tokens ignore local session expiry", async (context) => {
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

  assert.equal(await getUserForMcpToken(legacyToken), "user@example.com");
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

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
