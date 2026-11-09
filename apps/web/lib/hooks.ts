"use client";
import { useEffect, useRef, useState } from "react";
import useSWR, { type SWRConfiguration } from "swr";
import { fetcher, streamUrl } from "./api";
import type { EngineEvent } from "./types";

export function useApi<T>(path: string | null, opts: SWRConfiguration = {}) {
  return useSWR<T>(path, fetcher, { revalidateOnFocus: true, ...opts });
}

/**
 * Live engine events over SSE. Resumes from the last event id after reconnects (the
 * browser's EventSource sends Last-Event-ID automatically). `onEvent` is called per event.
 */
export function useEventStream(query: string | null, onEvent: (e: EngineEvent) => void) {
  const cb = useRef(onEvent);
  cb.current = onEvent;
  const [state, setState] = useState<"connecting" | "live" | "reconnecting" | "off">(query ? "connecting" : "off");
  useEffect(() => {
    if (!query) {
      setState("off");
      return;
    }
    const es = new EventSource(streamUrl(`${query}&format=message`));
    es.onopen = () => setState("live");
    es.onerror = () => setState("reconnecting");
    const handler = (m: MessageEvent) => {
      try {
        cb.current(JSON.parse(m.data) as EngineEvent);
      } catch {
        /* ignore malformed frame */
      }
    };
    es.onmessage = handler;
    return () => es.close();
  }, [query]);
  return state;
}
/** Persisted selected project (portal-wide). */
export function useSelectedProject(projects: { id: string }[] | undefined): [string | null, (id: string) => void] {
  const [id, setId] = useState<string | null>(null);
  useEffect(() => {
    const saved = typeof window !== "undefined" ? localStorage.getItem("agentmesh.project") : null;
    if (projects?.length) setId(saved && projects.some((p) => p.id === saved) ? saved : projects[0]!.id);
  }, [projects]);
  return [
    id,
    (next) => {
      localStorage.setItem("agentmesh.project", next);
      setId(next);
    },
  ];
}
