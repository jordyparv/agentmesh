import { cn } from "@/lib/utils";

/** Minimal unified-diff renderer (no external dependency); one file section per `diff --git`. */
export function DiffView({ diff, className }: { diff: string; className?: string }) {
  if (!diff.trim()) return <p className="p-3 text-xs text-muted-foreground">No textual changes.</p>;
  const lines = diff.split("\n");
  return (
    <pre className={cn("max-h-[60vh] overflow-auto rounded-md border bg-muted/30 font-mono text-[12px] leading-5", className)} aria-label="Diff">
      {lines.map((l, i) => {
        const tone = l.startsWith("diff --git")
          ? "bg-accent font-semibold border-t"
          : l.startsWith("+++") || l.startsWith("---")
            ? "text-muted-foreground"
            : l.startsWith("@@")
              ? "text-info"
              : l.startsWith("+")
                ? "bg-success/10 text-success"
                : l.startsWith("-")
                  ? "bg-danger/10 text-danger"
                  : "";
        return (
          <div key={i} className={cn("whitespace-pre px-3", tone)}>
            {l || " "}
          </div>
        );
      })}
    </pre>
  );
}
