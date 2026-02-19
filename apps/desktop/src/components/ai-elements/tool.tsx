import type { ComponentProps } from "react";

import { CheckCircleIcon, ChevronDownIcon, CircleIcon, ClockIcon, WrenchIcon, XCircleIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
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
    return <CheckCircleIcon className="h-4 w-4 text-emerald-500" />;
  }
  if (state === "error") {
    return <XCircleIcon className="h-4 w-4 text-destructive" />;
  }
  return <ClockIcon className="h-4 w-4 animate-pulse text-primary" />;
}

export type ToolProps = ComponentProps<typeof Collapsible>;

export function Tool({ className, ...props }: ToolProps) {
  return <Collapsible className={cn("w-full rounded-lg border border-border/80 bg-card/75", className)} {...props} />;
}

export type ToolHeaderProps = ComponentProps<typeof CollapsibleTrigger> & {
  title: string;
  subtitle?: string;
  status: ToolState;
};

export function ToolHeader({ className, title, subtitle, status, ...props }: ToolHeaderProps) {
  return (
    <CollapsibleTrigger
      className={cn("group flex w-full items-start justify-between gap-3 p-3 text-left", className)}
      {...props}
    >
      <div className="flex min-w-0 items-start gap-2">
        <WrenchIcon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <div className="truncate font-medium text-sm text-foreground">{title}</div>
          {subtitle ? <div className="truncate text-xs text-muted-foreground">{subtitle}</div> : null}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Badge variant="secondary" className="gap-1.5">
          <ToolStatusIcon state={status} />
          {statusLabel[status]}
        </Badge>
        <ChevronDownIcon className="h-4 w-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
      </div>
    </CollapsibleTrigger>
  );
}

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>;

export function ToolContent({ className, ...props }: ToolContentProps) {
  return <CollapsibleContent className={cn("space-y-3 border-t border-border/70 px-3 pb-3 pt-3", className)} {...props} />;
}

export type ToolKeyValueProps = {
  label: string;
  value: string;
};

export function ToolKeyValue({ label, value }: ToolKeyValueProps) {
  return (
    <div className="rounded-md border border-border/70 bg-muted/35 px-2.5 py-2">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 break-words text-xs text-foreground">{value}</div>
    </div>
  );
}

export type ToolCodeBlockProps = {
  label: string;
  value: string;
  tone?: "default" | "error";
};

export function ToolCodeBlock({ label, value, tone = "default" }: ToolCodeBlockProps) {
  return (
    <div className="space-y-1.5">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
      <pre
        className={cn(
          "max-h-72 overflow-auto rounded-md border border-border/70 bg-muted/35 p-3 text-xs",
          tone === "error" ? "border-destructive/40 bg-destructive/10 text-destructive" : "text-foreground",
        )}
      >
        {value}
      </pre>
    </div>
  );
}

export const ToolRunningIcon = CircleIcon;
