/**
 * Browser-side API client. All calls go through the same-origin proxy (/api/proxy/v1/...),
 * which attaches the server-held token. No business logic lives here or in components:
 * the engine decides; the UI requests actions and renders state.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

const BASE = "/api/proxy/v1";

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: init.method ?? "GET",
    headers: { ...(init.body !== undefined ? { "content-type": "application/json" } : {}), ...init.headers },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    cache: "no-store",
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const e = data?.error ?? {};
    throw new ApiError(res.status, e.code ?? "HTTP_ERROR", e.message ?? `Request failed (${res.status})`, e.details);
  }
  return data as T;
}

export const fetcher = <T,>(path: string) => api<T>(path);
export const streamUrl = (query: string) => `${BASE}/events/stream?${query}`;
