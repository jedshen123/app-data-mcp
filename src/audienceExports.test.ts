import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAudienceExport } from "./audienceExports.js";

test("creates a bounded expiring UID CSV with a capability URL", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "audience-export-test-"));
  const previous = {
    directory: process.env.AUDIENCE_EXPORT_DIR,
    publicBaseUrl: process.env.APP_DATA_MCP_PUBLIC_BASE_URL,
    maxRows: process.env.AUDIENCE_EXPORT_MAX_ROWS
  };
  process.env.AUDIENCE_EXPORT_DIR = directory;
  process.env.APP_DATA_MCP_PUBLIC_BASE_URL = "https://mcp.example.test";
  process.env.AUDIENCE_EXPORT_MAX_ROWS = "2";
  context.after(async () => {
    if (previous.directory === undefined) delete process.env.AUDIENCE_EXPORT_DIR;
    else process.env.AUDIENCE_EXPORT_DIR = previous.directory;
    if (previous.publicBaseUrl === undefined) delete process.env.APP_DATA_MCP_PUBLIC_BASE_URL;
    else process.env.APP_DATA_MCP_PUBLIC_BASE_URL = previous.publicBaseUrl;
    if (previous.maxRows === undefined) delete process.env.AUDIENCE_EXPORT_MAX_ROWS;
    else process.env.AUDIENCE_EXPORT_MAX_ROWS = previous.maxRows;
    await fs.rm(directory, { recursive: true, force: true });
  });

  const result = await createAudienceExport(["uid-1", "uid,\"2"], {
    user: "user@example.test",
    filename: "../my/users"
  });
  assert.equal(result.rowCount, 2);
  assert.equal(result.downloadName, "-my-users.csv");
  assert.match(result.downloadUrl, /^https:\/\/mcp\.example\.test\/exports\/audience\/[A-Za-z0-9_-]{43}$/);
  assert.equal(await fs.readFile(result.localPath, "utf8"), 'uid\nuid-1\n"uid,""2"\n');
  assert.equal(result.sha256.length, 64);

  await assert.rejects(
    () => createAudienceExport(["1", "2", "3"], {}),
    /audience_export_too_many_rows/
  );
});
