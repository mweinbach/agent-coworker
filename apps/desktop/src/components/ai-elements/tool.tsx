import type { ComponentProps } from "react";
import type { ToolFeedState } from "../../app/types";

import {
  CheckCircleIcon,
  ChevronDownIcon,
  CircleIcon,
  ClockIcon,
  GlobeIcon,
  ListTodoIcon,
  SearchIcon,
  TerminalIcon,
  WrenchIcon,
  XCircleIcon,
} from "lucide-react";

import { Badge } from "../ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible";
import { cn } from "../../lib/utils";

type ToolVariant = "default" | "trace";

const stateLabel: Record<ToolFeedState, string> = {
  "input-streaming": "Capturing Input",
  "input-available": "Running",
  "approval-requested": "Awaiting Approval",
  "output-available": "Done",
  "output-error": "Error",
  "output-denied": "Denied",
};

type ToolStatusIconProps = {
  state: ToolFeedState;
};

function ToolStatusIcon({ state }: ToolStatusIconProps) {
  if (state === "output-available") {
    return <CheckCircleIcon className="size-3.5 text-emerald-500/90" />;
  }
  if (state === "output-error" || state === "output-denied") {
    return <XCircleIcon className="size-3.5 text-destructive" />;
  }
  if (state === "approval-requested") {
    return <CircleIcon className="size-3.5 text-primary" />;
  }
  return <ClockIcon className={cn("size-3.5 text-primary", state === "input-streaming" && "animate-pulse")} />;
}

export type ToolProps = ComponentProps<typeof Collapsible> & {
  variant?: ToolVariant;
};

export function Tool({ className, variant = "default", ...props }: ToolProps) {
  return (
    <Collapsible
      className={cn(
        variant === "trace"
          ? "w-full overflow-hidden rounded-xl border border-border/50 bg-background/50 shadow-sm"
          : "w-full max-w-3xl overflow-hidden rounded-lg border border-border/60 bg-background/55 shadow-sm transition-colors hover:bg-muted/15",
        className,
      )}
      {...props}
    />
  );
}

export type ToolHeaderProps = ComponentProps<typeof CollapsibleTrigger> & {
  title: string;
  subtitle?: string;
  state: ToolFeedState;
  showChevron?: boolean;
  variant?: ToolVariant;
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

export function ToolHeader({
  className,
  title,
  subtitle,
  state,
  showChevron = true,
  variant = "default",
  ...props
}: ToolHeaderProps) {
  if (variant === "trace") {
    return (
      <CollapsibleTrigger
        className={cn("group flex w-full items-start justify-between gap-3 px-3 py-2.5 text-left outline-none transition-colors hover:bg-muted/10", className)}
        {...props}
      >
        <div className="flex min-w-0 items-start gap-2.5">
          <div className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-md bg-muted/30 ring-1 ring-border/40 transition-colors group-hover:bg-muted/45">
            <ToolIcon title={title} className="size-3 text-muted-foreground/80" />
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold leading-5 text-foreground">{title}</div>
            {subtitle ? <div className="mt-0.5 whitespace-pre-wrap break-words text-xs leading-5 text-muted-foreground/85">{subtitle}</div> : null}
          </div>
        </div>
        <div className="flex shrink-0 items-start gap-2">
          <Badge
            variant={state === "output-error" || state === "output-denied" ? "destructive" : state === "output-available" ? "outline" : "secondary"}
            className="mt-0.5 gap-1 px-1.5 py-0 text-[9px] font-semibold uppercase tracking-[0.14em]"
          >
            <ToolStatusIcon state={state} />
            <span>{stateLabel[state]}</span>
          </Badge>
          {showChevron ? (
            <ChevronDownIcon className="mt-0.5 size-4 text-muted-foreground/40 transition-transform group-data-[state=open]:rotate-180" />
          ) : null}
        </div>
      </CollapsibleTrigger>
    );
  }

  return (
    <CollapsibleTrigger
      className={cn("group flex w-full items-center justify-between gap-3 px-2.5 py-2 text-left outline-none", className)}
      {...props}
    >
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex size-6 shrink-0 items-center justify-center rounded-lg bg-muted/30 ring-1 ring-border/40 transition-colors group-hover:bg-muted/50">
          <ToolIcon title={title} className="size-3.5 text-muted-foreground/80" />
        </div>
        <div className="min-w-0">
          <div className="truncate font-semibold leading-tight text-[12px] text-foreground">{title}</div>
          {subtitle ? <div className="mt-0.5 truncate text-[11px] text-muted-foreground/80">{subtitle}</div> : null}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Badge
          variant={state === "output-error" || state === "output-denied" ? "destructive" : state === "output-available" ? "outline" : "secondary"}
          className="gap-1.5 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
        >
          <ToolStatusIcon state={state} />
          <span>{stateLabel[state]}</span>
        </Badge>
        {showChevron ? <ChevronDownIcon className="size-4 text-muted-foreground/40 transition-transform group-data-[state=open]:rotate-180" /> : null}
      </div>
    </CollapsibleTrigger>
  );
}

export type ToolContentProps = ComponentProps<typeof CollapsibleContent> & {
  variant?: ToolVariant;
};

export function ToolContent({ className, variant = "default", ...props }: ToolContentProps) {
  return (
    <CollapsibleContent
      className={cn(
        variant === "trace"
          ? "flex flex-col gap-2 border-t border-border/50 px-3 pb-3 pt-2 select-text"
          : "flex flex-col gap-3 px-2.5 pb-2.5 pt-1 select-text",
        className,
      )}
      {...props}
    />
  );
}

export type ToolCodeBlockProps = {
  label: string;
  value: string;
  tone?: "default" | "error";
};

export function ToolCodeBlock({ label, value, tone = "default" }: ToolCodeBlockProps) {
  return (
    <div className="flex flex-col gap-1.5">
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
export { stateLabel as toolStateLabel };
