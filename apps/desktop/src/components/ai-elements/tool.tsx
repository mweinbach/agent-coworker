import type { ComponentProps } from "react";

import { CheckCircleIcon, ChevronDownIcon, CircleIcon, ClockIcon, GlobeIcon, ListTodoIcon, SearchIcon, TerminalIcon, WrenchIcon, XCircleIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible";

const statusLabel: Record<ToolState, string> = {
  running: "Running",
  done: "Done",
  error: "Error",
};

type ToolState = "running" | "done" | "error";

type ToolStatusIconProps = {
  state: ToolState;
};

function ToolStatusIcon({ state }: ToolStatusIconProps) {
  if (state === "done") {
    return <CheckCircleIcon className="h-3.5 w-3.5 text-emerald-500/90" />;
  }
  if (state === "error") {
    return <XCircleIcon className="h-3.5 w-3.5 text-destructive" />;
  }
  return <ClockIcon className="h-3.5 w-3.5 animate-pulse text-primary" />;
}

export type ToolProps = ComponentProps<typeof Collapsible>;

export function Tool({ className, ...props }: ToolProps) {
  return (
    <Collapsible
      className={cn(
        "w-full max-w-3xl overflow-hidden rounded-xl border border-transparent bg-muted/10 ring-1 ring-border/30 transition-all hover:bg-muted/20",
        className,
      )}
      {...props}
    />
  );
}

export type ToolHeaderProps = ComponentProps<typeof CollapsibleTrigger> & {
  title: string;
  subtitle?: string;
  status: ToolState;
};

function ToolIcon({ title, className }: { title: string; className?: string }) {
  const t = title.toLowerCase();
  if (t.includes("todo") || t.includes("task")) {
    return <ListTodoIcon className={className} />;
  }
  if (t.includes("search") || t.includes("grep") || t.includes("glob")) {
    return <SearchIcon className={className} />;
  }
  if (t.includes("fetch") || t.includes("web") || t.includes("browser")) {
    return <GlobeIcon className={className} />;
  }
  if (t.includes("bash") || t.includes("shell") || t.includes("run")) {
    return <TerminalIcon className={className} />;
  }
  return <WrenchIcon className={className} />;
}

export function ToolHeader({ className, title, subtitle, status, ...props }: ToolHeaderProps) {
  return (
    <CollapsibleTrigger
      className={cn("group flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left outline-none", className)}
      {...props}
    >
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-background shadow-sm ring-1 ring-border/40 transition-colors group-hover:bg-muted/50">
          <ToolIcon title={title} className="h-3.5 w-3.5 text-muted-foreground/80" />
        </div>
        <div className="min-w-0 py-0.5">
          <div className="truncate font-semibold leading-tight text-[13px] text-foreground">{title}</div>
          {subtitle ? <div className="mt-0.5 truncate text-[11px] text-muted-foreground/80">{subtitle}</div> : null}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <div className="flex items-center gap-1.5 text-[10px] font-semibold tracking-wide text-muted-foreground/60 uppercase">
          <ToolStatusIcon state={status} />
          <span className="hidden sm:inline-block">{statusLabel[status]}</span>
        </div>
        <ChevronDownIcon className="h-4 w-4 text-muted-foreground/40 transition-transform group-data-[state=open]:rotate-180" />
      </div>
    </CollapsibleTrigger>
  );
}

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>;

export function ToolContent({ className, ...props }: ToolContentProps) {
  return <CollapsibleContent className={cn("select-text space-y-4 px-3 pb-3 pt-1", className)} {...props} />;
}

export type ToolCodeBlockProps = {
  label: string;
  value: string;
  tone?: "default" | "error";
};

export function ToolCodeBlock({ label, value, tone = "default" }: ToolCodeBlockProps) {
  return (
    <div className="space-y-1.5">
      <div className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">{label}</div>
      <pre
        className={cn(
          "max-h-72 overflow-auto rounded-lg bg-background/40 p-3 text-[11px] leading-relaxed shadow-sm ring-1 ring-border/20",
          tone === "error" ? "bg-destructive/5 text-destructive ring-destructive/20" : "text-foreground/80",
        )}
      >
        {value}
      </pre>
    </div>
  );
}

export const ToolRunningIcon = CircleIcon;
