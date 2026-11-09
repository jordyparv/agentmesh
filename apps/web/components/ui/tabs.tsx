"use client";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Tabs<T extends string>({ value, onChange, items, className }: { value: T; onChange: (v: T) => void; items: { value: T; label: ReactNode }[]; className?: string }) {
  return (
    <div role="tablist" className={cn("flex gap-0.5 border-b", className)}>
      {items.map((it) => (
        <button
          key={it.value}
          role="tab"
          aria-selected={value === it.value}
          onClick={() => onChange(it.value)}
          className={cn("-mb-px border-b-2 px-3 py-1.5 text-sm", value === it.value ? "border-foreground font-medium" : "border-transparent text-muted-foreground hover:text-foreground")}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}
