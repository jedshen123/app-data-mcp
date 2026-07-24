import { AsyncLocalStorage } from "node:async_hooks";

export type RequestContext = {
  requestId?: string;
  user?: string;
  groups: string[];
  metabaseSession?: string;
  authMethod?: "mcp-token" | "none";
  aiClient?: string;
  aiClientVersion?: string;
  clientIp?: string;
  userAgent?: string;
};

const storage = new AsyncLocalStorage<RequestContext>();

export function withRequestContext<T>(context: RequestContext, callback: () => T): T {
  return storage.run(context, callback);
}

export function getRequestContext(): RequestContext {
  return storage.getStore() ?? { groups: [] };
}
