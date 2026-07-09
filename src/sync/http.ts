export async function fetchJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status} ${response.statusText} for ${url}${body ? `: ${body.slice(0, 500)}` : ""}`);
  }
  return (await response.json()) as T;
}

export function joinUrl(baseUrl: string, pathname: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const path = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `${base}${path}`;
}

export function asArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (isObject(value) && Array.isArray(value.data)) return value.data as T[];
  if (isObject(value) && Array.isArray(value.results)) return value.results as T[];
  return [];
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function getNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function getObject(value: unknown): Record<string, unknown> | undefined {
  return isObject(value) ? value : undefined;
}
