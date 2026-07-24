#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import express from "express";
import { registerAudienceExportRoutes } from "./audienceExports.js";
import { registerAdminRoutes } from "./admin/adminRoutes.js";
import { identifyAiClient, identifyAiClientVersion } from "./aiClient.js";
import { registerLoginRoutes } from "./auth/loginRoutes.js";
import { getUserForMcpToken } from "./auth/metabaseSessions.js";
import { getHttpConfig } from "./config.js";
import { createAppDataMcpServer } from "./mcp.js";
import { withRequestContext } from "./requestContext.js";

const { host, port, bearerToken, allowedHosts } = getHttpConfig();

const app = createMcpExpressApp({ host, allowedHosts });
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));
registerLoginRoutes(app);
registerAdminRoutes(app);
registerAudienceExportRoutes(app);

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    name: "app-data-mcp",
    transport: "streamable-http"
  });
});

app.use("/mcp", async (req, res, next) => {
  const token = parseBearerToken(req.header("authorization"));
  const tokenUser = await getUserForMcpToken(token);
  res.locals.appDataUser = tokenUser;

  if (!bearerToken) {
    if (token && !tokenUser) {
      res.status(401).json({
        jsonrpc: "2.0",
        error: {
          code: -32001,
          message: "Invalid app-data MCP token"
        },
        id: null
      });
      return;
    }
    next();
    return;
  }

  const expected = `Bearer ${bearerToken}`;
  if (req.header("authorization") !== expected && !tokenUser) {
    res.status(401).json({
      jsonrpc: "2.0",
      error: {
        code: -32001,
        message: "Unauthorized"
      },
      id: null
    });
    return;
  }

  next();
});

app.post("/mcp", async (req, res) => {
  const requestUser = typeof res.locals.appDataUser === "string" ? res.locals.appDataUser : undefined;
  const server = await createAppDataMcpServer({ user: requestUser });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true
  });

  try {
    await withRequestContext(
      {
        requestId: randomUUID(),
        user: requestUser,
        groups: splitHeader(req.header("x-app-data-groups")),
        metabaseSession: req.header("x-metabase-session") ?? undefined,
        authMethod: requestUser ? "mcp-token" : "none",
        aiClient: getAiClient(req),
        aiClientVersion: getAiClientVersion(req),
        clientIp: getClientIp(req),
        userAgent: req.header("user-agent") ?? undefined
      },
      async () => {
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      }
    );
  } catch (error) {
    console.error("Error handling MCP HTTP request:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: "Internal server error"
        },
        id: null
      });
    }
  } finally {
    res.on("close", () => {
      transport.close().catch((closeError) => console.error("Error closing transport:", closeError));
      server.close().catch((closeError) => console.error("Error closing MCP server:", closeError));
    });
  }
});

function splitHeader(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseBearerToken(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim();
}

function getClientIp(req: express.Request): string | undefined {
  const forwardedFor = req.header("x-forwarded-for")?.split(",")[0]?.trim();
  return forwardedFor || req.ip || req.socket.remoteAddress || undefined;
}

function getAiClient(req: express.Request): string {
  return identifyAiClient(
    req.header("x-app-data-client"),
    req.header("user-agent")
  );
}

function getAiClientVersion(req: express.Request): string | undefined {
  return identifyAiClientVersion(
    req.header("x-app-data-client-version"),
    req.header("user-agent"),
    getAiClient(req)
  );
}

app.get("/mcp", (_req, res) => {
  res.status(405).set("Allow", "POST").json({
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message: "Method not allowed. Use POST /mcp for Streamable HTTP."
    },
    id: null
  });
});

app.delete("/mcp", (_req, res) => {
  res.status(405).set("Allow", "POST").json({
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message: "Method not allowed. Use POST /mcp for Streamable HTTP."
    },
    id: null
  });
});

app.listen(port, host, (error) => {
  if (error) {
    console.error("Failed to start MCP HTTP server:", error);
    process.exit(1);
  }

  console.error(`App Data MCP HTTP server listening on http://${host}:${port}/mcp`);
});
