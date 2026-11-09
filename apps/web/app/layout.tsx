import type { Metadata } from "next";
import type { ReactNode } from "react";
import { ProjectProvider } from "@/components/project-context";
import { Shell } from "@/components/shell";
import { ToastProvider } from "@/components/ui/toast";
import "./globals.css";

export const metadata: Metadata = { title: "AgentMesh Control Center", description: "Multi-agent orchestration" };

// Sets the theme before first paint (no flash). Static string, no user input.
const THEME_SCRIPT = `try{var t=localStorage.getItem("agentmesh.theme");if(t==="dark"||(!t&&matchMedia("(prefers-color-scheme: dark)").matches))document.documentElement.classList.add("dark")}catch(e){}`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="font-sans antialiased">
        <ToastProvider>
          <ProjectProvider>
            <Shell>{children}</Shell>
          </ProjectProvider>
        </ToastProvider>
      </body>
    </html>
  );
}
