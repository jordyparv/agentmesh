"use client";
import { Bot, BrainCircuit, FolderGit2, GitPullRequestArrow, KanbanSquare, LayoutDashboard, Moon, Sun, Workflow } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { useApi } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import { useProject } from "./project-context";
import { Select } from "./ui/input";

const NAV = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/tasks", label: "Tasks", icon: KanbanSquare },
  { href: "/reviews", label: "Reviews", icon: GitPullRequestArrow },
  { href: "/knowledge", label: "Knowledge", icon: BrainCircuit },
  { href: "/workflows", label: "Workflows", icon: Workflow },
  { href: "/agents", label: "Agents", icon: Bot },
  { href: "/projects", label: "Projects", icon: FolderGit2 },
];

function ThemeToggle() {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    setDark(document.documentElement.classList.contains("dark"));
  }, []);
  const toggle = () => {
    const next = !dark;
    document.documentElement.classList.toggle("dark", next);
    localStorage.setItem("agentmesh.theme", next ? "dark" : "light");
    setDark(next);
  };
  return (
    <button onClick={toggle} aria-label={dark ? "Switch to light theme" : "Switch to dark theme"} className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
      {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </button>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const { projects, projectId, setProjectId, error } = useProject();
  const { data: reviews } = useApi<unknown[]>("/reviews", { refreshInterval: 15_000 });
  return (
    <div className="flex min-h-screen">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-card focus:px-2 focus:py-1">
        Skip to content
      </a>
      <aside className="sticky top-0 hidden h-screen w-52 shrink-0 flex-col border-r bg-card md:flex">
        <div className="flex h-12 items-center gap-2 border-b px-4">
          <div className="size-5 rounded bg-primary" aria-hidden />
          <span className="text-sm font-semibold tracking-tight">AgentMesh</span>
        </div>
        <nav aria-label="Main" className="flex flex-1 flex-col gap-0.5 p-2">
          {NAV.map(({ href, label, icon: Icon }) => {
            const active = href === "/" ? path === "/" : path.startsWith(href);
            return (
              <Link key={href} href={href} aria-current={active ? "page" : undefined} className={cn("flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm", active ? "bg-accent font-medium" : "text-muted-foreground hover:bg-accent hover:text-foreground")}>
                <Icon className="size-4" />
                <span className="flex-1">{label}</span>
                {href === "/reviews" && reviews?.length ? <span className="rounded bg-warning/15 px-1.5 text-[11px] font-medium text-warning">{reviews.length}</span> : null}
              </Link>
            );
          })}
        </nav>
        <p className="border-t px-4 py-2 text-[11px] text-muted-foreground">Local control center</p>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex h-12 items-center gap-3 border-b bg-background/95 px-4 backdrop-blur">
          <nav aria-label="Main (mobile)" className="flex gap-1 overflow-x-auto md:hidden">
            {NAV.map(({ href, icon: Icon, label }) => (
              <Link key={href} href={href} aria-label={label} className="rounded p-1.5 text-muted-foreground hover:bg-accent">
                <Icon className="size-4" />
              </Link>
            ))}
          </nav>
          <div className="flex items-center gap-2">
            <label htmlFor="project-select" className="text-xs text-muted-foreground">
              Project
            </label>
            <Select id="project-select" className="h-7 w-56" value={projectId ?? ""} onChange={(e) => setProjectId(e.target.value)} disabled={!projects?.length}>
              {!projects?.length ? <option value="">{error ? "API unavailable" : "No projects"}</option> : null}
              {projects?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="ml-auto">
            <ThemeToggle />
          </div>
        </header>
        <main id="main" className="mx-auto w-full max-w-[1400px] flex-1 p-4 md:p-6">
          {children}
        </main>
      </div>
    </div>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}
