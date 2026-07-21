import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type express from "express";
import { getAudienceExportConfig, getAuthConfig, getHttpConfig } from "./config.js";

type AudienceExportMetadata = {
  token: string;
  user?: string;
  createdAt: string;
  expiresAt: string;
  downloadName: string;
  rowCount: number;
  bytes: number;
  sha256: string;
};

export type AudienceExportResult = AudienceExportMetadata & {
  downloadUrl: string;
  localPath: string;
};

export async function createAudienceExport(
  uids: unknown[],
  input: { user?: string; filename?: string }
): Promise<AudienceExportResult> {
  const config = getAudienceExportConfig();
  if (uids.length > config.maxRows) {
    throw new Error(`audience_export_too_many_rows: maximum ${config.maxRows} UID rows.`);
  }

  const directory = path.resolve(process.cwd(), config.directory);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await cleanupExpiredAudienceExports(directory);

  const token = randomBytes(32).toString("base64url");
  const downloadName = normalizeDownloadName(input.filename);
  const csv = `uid\n${uids.map((uid) => `${escapeCsvValue(uid)}\n`).join("")}`;
  const bytes = Buffer.byteLength(csv, "utf8");
  if (bytes > config.maxBytes) {
    throw new Error(`audience_export_too_large: CSV exceeds ${config.maxBytes} bytes.`);
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + config.ttlHours * 60 * 60 * 1000);
  const metadata: AudienceExportMetadata = {
    token,
    user: input.user,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    downloadName,
    rowCount: uids.length,
    bytes,
    sha256: createHash("sha256").update(csv).digest("hex")
  };
  const csvPath = path.join(directory, `${token}.csv`);
  const metadataPath = path.join(directory, `${token}.json`);
  await fs.writeFile(csvPath, csv, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    await fs.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
  } catch (error) {
    await fs.unlink(csvPath).catch(() => undefined);
    throw error;
  }

  return {
    ...metadata,
    downloadUrl: `${getPublicBaseUrl()}/exports/audience/${token}`,
    localPath: csvPath
  };
}

export function registerAudienceExportRoutes(app: express.Express): void {
  const exportDirectory = path.resolve(process.cwd(), getAudienceExportConfig().directory);
  void cleanupExpiredAudienceExports(exportDirectory);
  const cleanupTimer = setInterval(() => {
    void cleanupExpiredAudienceExports(exportDirectory);
  }, 15 * 60 * 1000);
  cleanupTimer.unref();

  app.get("/exports/audience/:token", async (req, res) => {
    const token = typeof req.params.token === "string" ? req.params.token : "";
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
      res.status(404).json({ error: "audience_export_not_found" });
      return;
    }

    const directory = path.resolve(process.cwd(), getAudienceExportConfig().directory);
    const metadataPath = path.join(directory, `${token}.json`);
    const csvPath = path.join(directory, `${token}.csv`);
    try {
      const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8")) as AudienceExportMetadata;
      if (metadata.token !== token) throw new Error("token_mismatch");
      if (new Date(metadata.expiresAt).getTime() <= Date.now()) {
        await Promise.all([
          fs.unlink(metadataPath).catch(() => undefined),
          fs.unlink(csvPath).catch(() => undefined)
        ]);
        res.status(410).json({ error: "audience_export_expired" });
        return;
      }
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.type("text/csv");
      res.attachment(metadata.downloadName);
      res.send(await fs.readFile(csvPath));
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        res.status(404).json({ error: "audience_export_not_found" });
        return;
      }
      res.status(500).json({ error: "audience_export_read_failed" });
    }
  });
}

async function cleanupExpiredAudienceExports(directory: string): Promise<void> {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  const metadataFiles = entries.filter((entry) => entry.isFile() && /^[A-Za-z0-9_-]{43}\.json$/.test(entry.name));
  await Promise.all(metadataFiles.map(async (entry) => {
    const metadataPath = path.join(directory, entry.name);
    try {
      const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8")) as AudienceExportMetadata;
      if (new Date(metadata.expiresAt).getTime() > Date.now()) return;
      const token = entry.name.slice(0, -5);
      await Promise.all([
        fs.unlink(metadataPath).catch(() => undefined),
        fs.unlink(path.join(directory, `${token}.csv`)).catch(() => undefined)
      ]);
    } catch {
      // Leave malformed metadata for an administrator to inspect instead of deleting an unknown file.
    }
  }));
}

function normalizeDownloadName(value: string | undefined): string {
  const fallback = `audience-${new Date().toISOString().slice(0, 10)}.csv`;
  const trimmed = value?.trim();
  if (!trimmed) return fallback;
  const safe = trimmed.replace(/[\\/\0\r\n]/g, "-").replace(/^\.+/, "").slice(0, 100);
  if (!safe) return fallback;
  return safe.toLocaleLowerCase().endsWith(".csv") ? safe : `${safe}.csv`;
}

function escapeCsvValue(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error("audience_export_invalid_uid: UID values must be strings or numbers.");
  }
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function getPublicBaseUrl(): string {
  const configured = getAuthConfig().publicBaseUrl?.replace(/\/$/, "");
  if (configured) return configured;
  const { host, port } = getHttpConfig();
  const displayHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  return `http://${displayHost}:${port}`;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
