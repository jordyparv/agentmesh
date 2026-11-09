/** Parse one line of newline-delimited JSON, returning null for non-JSON noise. */
export function parseJsonLine(line: string): Record<string, unknown> | null {
  const t = line.trim();
  if (!t.startsWith("{")) return null;
  try {
    const v: unknown = JSON.parse(t);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
export function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
export function obj(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/** Heuristic classification of provider stderr/error text. */
export function classifyProviderError(text: string): "auth" | "rate_limit" | "provider_error" {
  const t = text.toLowerCase();
  if (/(unauthori[sz]ed|401|not logged in|login required|invalid api key|authentication)/.test(t)) return "auth";
  if (/(rate.?limit|429|quota|too many requests|overloaded)/.test(t)) return "rate_limit";
  return "provider_error";
}
