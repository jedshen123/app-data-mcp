#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createAppDataMcpServer } from "./mcp.js";

const transport = new StdioServerTransport();
const server = createAppDataMcpServer();
await server.connect(transport);
