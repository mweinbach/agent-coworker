import type { ComponentProps } from "react";

import { BrainIcon, ChevronDownIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible";
import { MessageResponse } from "./message";

type ReasoningVariant = "default" | "trace";

export type ReasoningProps = ComponentProps<typeof Collapsible>;

export function Reasoning({
  className,
  variant = "default",
  ...props
}: ReasoningProps & { variant?: ReasoningVariant }) {
  return (
    <Collapsible
      className={cn(
        variant === "trace"
          ? "app-shadow-surface rounded-xl border border-border/50 bg-background/50"
          : "rounded-lg border border-border/80 bg-muted/25",
        className,
      )}
      {...props}
    />
  );
}

export type ReasoningTriggerProps = ComponentProps<typeof CollapsibleTrigger> & {
  label: string;
  preview?: string;
  showChevron?: boolean;
  variant?: ReasoningVariant;
};

export function ReasoningTrigger({
  className,
  label,
  preview,
  showChevron = true,
  variant = "default",
  ...props
}: ReasoningTriggerProps) {
  if (variant === "trace") {
    return (
      <CollapsibleTrigger
        className={cn(
          "group flex w-full items-start justify-between gap-3 px-3 py-2.5 text-left outline-none transition-colors hover:bg-muted/10",
          className,
        )}
        {...props}
      >
        <span className="flex min-w-0 items-start gap-2.5">
          <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-md bg-muted/30 ring-1 ring-border/40">
            <BrainIcon className="size-3 text-muted-foreground/80" />
          </span>
          <span className="min-w-0">
            <span className="block text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              {label}
            </span>
            {preview ? (
              <span className="mt-1 block whitespace-pre-wrap break-words text-sm leading-5 text-foreground/85">
                {preview}
              </span>
            ) : null}
          </span>
        </span>
        {showChevron ? (
          <ChevronDownIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground/45 transition-transform group-data-[state=open]:rotate-180" />
        ) : null}
      </CollapsibleTrigger>
    );
  }

  return (
    <CollapsibleTrigger
      className={cn(
        "group flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground",
        className,
      )}
      {...props}
    >
      <span className="inline-flex items-center gap-2">
        <BrainIcon className="size-3.5" />
        {label}
      </span>
      {showChevron ? <ChevronDownIcon className="size-4 transition-transform group-data-[state=open]:rotate-180" /> : null}
    </CollapsibleTrigger>
  );
}

export type ReasoningContentProps = ComponentProps<typeof CollapsibleContent> & {
  children: string;
  variant?: ReasoningVariant;
};

export function ReasoningContent({ className, children, variant = "default", ...props }: ReasoningContentProps) {
  return (
    <CollapsibleContent
      className={cn(
        variant === "trace"
          ? "select-text border-t border-border/50 px-3 pb-3 pt-2.5 text-sm text-muted-foreground"
          : "select-text px-3 pb-3 pt-0 text-sm text-muted-foreground",
        className,
      )}
      {...props}
    >
      <MessageResponse>{children}</MessageResponse>
    </CollapsibleContent>
  );
}
