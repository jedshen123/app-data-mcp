import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getAuthConfig, getMetabaseConfig } from "../config.js";
import { fetchJson, joinUrl } from "../sync/http.js";

type StoredMetabaseSession = {
  user: string;
  session: string;
  /** Current token. Legacy session files may also contain mcpTokenHashes. */
  mcpTokenHash?: string;
  mcpTokenHashes?: string[];
  createdAt: string;
  expiresAt: string;
};

type LoginMetabaseUserResult = StoredMetabaseSession & {
  mcpToken: string;
};

type SessionFile = {
  version: number;
  sessions: Record<string, StoredMetabaseSession>;
};

export async function loginMetabaseUser(username: string, password: string): Promise<LoginMetabaseUserResult> {
  const config = getMetabaseConfig();
  const baseUrl = config.baseUrl;
  if (!baseUrl) {
    throw new Error("METABASE_BASE_URL is required for Metabase user login.");
  }

  const session = await fetchJson<{ id: string }>(joinUrl(baseUrl, "/api/session"), {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      username,
      password
    })
  });

  const now = new Date();
  const expiresAt = new Date(now.getTime() + getAuthConfig().metabaseSessionTtlHours * 60 * 60 * 1000);
  const mcpToken = createMcpToken();
  const stored: StoredMetabaseSession = {
    user: username,
    session: session.id,
    mcpTokenHash: hashMcpToken(mcpToken),
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString()
  };

  await saveMetabaseSession(stored);
  return {
    ...stored,
    mcpToken
  };
}

export async function getUserForMcpToken(token: string | undefined): Promise<string | undefined> {
  if (!token) return undefined;

  const tokenHash = hashMcpToken(token);
  const file = await readSessionFile();
  for (const entry of Object.values(file.sessions)) {
    if (getActiveTokenHash(entry) === tokenHash) return entry.user;
  }
  return undefined;
}

export async function getStoredMetabaseSession(user: string | undefined): Promise<string | undefined> {
  const status = await getStoredMetabaseSessionStatus(user);
  return status.authorized ? status.session : undefined;
}

export async function getStoredMetabaseSessionStatus(user: string | undefined): Promise<
  | {
      authorized: true;
      user: string;
      session: string;
      createdAt: string;
      expiresAt: string;
    }
  | {
      authorized: false;
      user?: string;
      reason: "missing_user" | "missing_session";
      expiresAt?: string;
    }
> {
  if (!user) {
    return {
      authorized: false,
      reason: "missing_user"
    };
  }
  const file = await readSessionFile();
  const entry = file.sessions[normalizeUser(user)];
  if (!entry) {
    return {
      authorized: false,
      user,
      reason: "missing_session"
    };
  }
  return {
    authorized: true,
    user: entry.user,
    session: entry.session,
    createdAt: entry.createdAt,
    expiresAt: entry.expiresAt
  };
}

async function saveMetabaseSession(session: StoredMetabaseSession): Promise<void> {
  const filePath = getSessionFilePath();
  const file = await readSessionFile();
  file.sessions[normalizeUser(session.user)] = session;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(file, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

async function readSessionFile(): Promise<SessionFile> {
  const filePath = getSessionFilePath();
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<SessionFile>;
    return {
      version: 2,
      sessions: parsed.sessions ?? {}
    };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { version: 2, sessions: {} };
    }
    throw error;
  }
}

function getSessionFilePath(): string {
  return path.resolve(process.cwd(), getAuthConfig().sessionFile);
}

function normalizeUser(user: string): string {
  return user.trim().toLowerCase();
}

function createMcpToken(): string {
  return `appdata_${randomBytes(32).toString("base64url")}`;
}

function hashMcpToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function getActiveTokenHash(entry: StoredMetabaseSession): string | undefined {
  // Older versions appended tokens to this array. Its last item is the newest token.
  return entry.mcpTokenHashes?.at(-1) ?? entry.mcpTokenHash;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
