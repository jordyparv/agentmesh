"use client";
import { X } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Button } from "./button";

/** Accessible modal built on the native <dialog> (focus trap + Escape handled by the browser). */
export function Dialog({ open, onClose, title, children, footer, className }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode; className?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      aria-label={title}
      className={cn("m-auto w-full max-w-lg rounded-lg border bg-card p-0 text-foreground shadow-xl backdrop:bg-black/40", className)}
    >
      <div className="flex items-center justify-between border-b px-4 py-2.5">
        <h2 className="text-sm font-semibold">{title}</h2>
        <Button variant="ghost" size="icon" aria-label="Close" onClick={onClose}>
          <X />
        </Button>
      </div>
      <div className="max-h-[70vh] overflow-y-auto p-4">{children}</div>
      {footer ? <div className="flex justify-end gap-2 border-t px-4 py-2.5">{footer}</div> : null}
    </dialog>
  );
}
