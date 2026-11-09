"use client";
import { createContext, useContext, type ReactNode } from "react";
import { useApi, useSelectedProject } from "@/lib/hooks";
import type { Project } from "@/lib/types";

interface Ctx {
  projects: Project[] | undefined;
  projectId: string | null;
  project: Project | null;
  setProjectId: (id: string) => void;
  error: unknown;
  reload: () => void;
}
const ProjectCtx = createContext<Ctx>({ projects: undefined, projectId: null, project: null, setProjectId: () => undefined, error: null, reload: () => undefined });

export function ProjectProvider({ children }: { children: ReactNode }) {
  const { data, error, mutate } = useApi<Project[]>("/projects");
  const [projectId, setProjectId] = useSelectedProject(data);
  const project = data?.find((p) => p.id === projectId) ?? null;
  return <ProjectCtx.Provider value={{ projects: data, projectId, project, setProjectId, error, reload: () => void mutate() }}>{children}</ProjectCtx.Provider>;
}
export const useProject = () => useContext(ProjectCtx);
