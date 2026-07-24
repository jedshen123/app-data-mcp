type ClientRule = {
  name: string;
  patterns: RegExp[];
};

const CLIENT_RULES: ClientRule[] = [
  { name: "workbuddy", patterns: [/\bworkbuddy\b/] },
  { name: "claude-code", patterns: [/\bclaude[\s_-]?code\b/, /\bclaude-cli\b/] },
  { name: "claude-desktop", patterns: [/\bclaude[\s_-]?desktop\b/] },
  { name: "claude", patterns: [/\bclaude\b/] },
  { name: "codex", patterns: [/\bcodex\b/] },
  { name: "chatgpt", patterns: [/\bchatgpt\b/] },
  { name: "cursor", patterns: [/\bcursor\b/] },
  { name: "windsurf", patterns: [/\bwindsurf\b/] },
  { name: "roo-code", patterns: [/\broo[\s_-]?code\b/, /\broocode\b/] },
  { name: "cline", patterns: [/\bcline\b/] },
  { name: "continue", patterns: [/\bcontinue(?:\.dev)?\b/] },
  { name: "github-copilot", patterns: [/\bgithub[\s_-]?copilot\b/, /\bcopilot\b/] },
  { name: "gemini-cli", patterns: [/\bgemini[\s_-]?cli\b/] },
  { name: "gemini", patterns: [/\bgemini\b/] },
  { name: "antigravity", patterns: [/\bantigravity\b/] },
  { name: "kiro", patterns: [/\bkiro\b/] },
  { name: "amazon-q", patterns: [/\bamazon[\s_-]?q\b/] },
  { name: "goose", patterns: [/\bgoose\b/] },
  { name: "opencode", patterns: [/\bopen[\s_-]?code\b/] },
  { name: "zed", patterns: [/\bzed\b/] },
  { name: "vscode", patterns: [/\bvisual studio code\b/, /\bvscode\b/] },
  { name: "jetbrains", patterns: [/\bjetbrains\b/, /\bintellij\b/, /\bpycharm\b/, /\bwebstorm\b/] },
  { name: "mcp-inspector", patterns: [/\bmcp[\s_-]?inspector\b/] },
  { name: "dify", patterns: [/\bdify\b/] },
  { name: "coze", patterns: [/\bcoze\b/] },
  { name: "n8n", patterns: [/\bn8n\b/] },
  { name: "lobechat", patterns: [/\blobe[\s_-]?chat\b/] },
  { name: "cherry-studio", patterns: [/\bcherry[\s_-]?studio\b/] },
  { name: "anythingllm", patterns: [/\banything[\s_-]?llm\b/] },
  { name: "open-webui", patterns: [/\bopen[\s_-]?webui\b/] },
  { name: "langchain", patterns: [/\blangchain\b/, /\blanggraph\b/] },
  { name: "postman", patterns: [/\bpostmanruntime\b/, /\bpostman\b/] },
  { name: "curl", patterns: [/\bcurl\b/] },
  { name: "python-http", patterns: [/\bpython-requests\b/, /\bhttpx\b/, /\baiohttp\b/] },
  { name: "node-http", patterns: [/\bundici\b/, /\bnode-fetch\b/, /\baxios\b/] },
  { name: "browser", patterns: [/\bmozilla\/\d/] }
];

export function identifyAiClient(explicitClient?: string, userAgent?: string): string {
  const explicit = explicitClient?.trim();
  if (explicit) return explicit;

  const normalizedUserAgent = userAgent?.trim().toLowerCase();
  if (!normalizedUserAgent) return "unknown";

  for (const rule of CLIENT_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(normalizedUserAgent))) return rule.name;
  }

  return inferProductName(normalizedUserAgent) ?? "unknown";
}

export function resolveAuditAiClient(
  recordedClient?: string,
  userAgent?: string
): string {
  const recorded = recordedClient?.trim();
  if (recorded && recorded.toLowerCase() !== "unknown") return recorded;
  return identifyAiClient(undefined, userAgent);
}

export function identifyAiClientVersion(
  explicitVersion?: string,
  userAgent?: string,
  clientName?: string
): string | undefined {
  const explicit = explicitVersion?.trim();
  if (explicit) return explicit;

  const normalizedUserAgent = userAgent?.trim().toLowerCase();
  if (!normalizedUserAgent) return undefined;

  const resolvedClient = clientName ?? identifyAiClient(undefined, normalizedUserAgent);
  if (resolvedClient === "browser") {
    return normalizedUserAgent.match(/\b(?:edg|chrome|firefox)\/v?([0-9][\w.+-]*)/)?.[1]
      ?? normalizedUserAgent.match(/\bversion\/v?([0-9][\w.+-]*)/)?.[1];
  }

  const products = normalizedUserAgent.matchAll(
    /(?:^|[\s(])([a-z][a-z0-9._-]*(?:[\s_-][a-z][a-z0-9._-]*)?)\/v?([0-9][\w.+-]*)/g
  );
  for (const match of products) {
    if (identifyAiClient(undefined, match[1]) === resolvedClient) return match[2];
  }
  return undefined;
}

export function resolveAuditAiClientVersion(
  recordedVersion?: string,
  userAgent?: string,
  clientName?: string
): string | undefined {
  return identifyAiClientVersion(recordedVersion, userAgent, clientName);
}

function inferProductName(userAgent: string): string | undefined {
  const product = userAgent.match(/^([a-z][a-z0-9._-]{1,63})(?:\/[\w.+-]+)?(?:\s|$)/)?.[1];
  if (!product) return undefined;
  return product.replaceAll("_", "-");
}
