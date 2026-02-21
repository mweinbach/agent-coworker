import type { ComponentProps } from "react";

import { BrainIcon, ChevronDownIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible";
import { MessageResponse } from "./message";

export type ReasoningProps = ComponentProps<typeof Collapsible>;

export function Reasoning(props: ReasoningProps) {
  return <Collapsible className={cn("rounded-lg border border-border/80 bg-muted/25", props.className)} {...props} />;
}

export type ReasoningTriggerProps = ComponentProps<typeof CollapsibleTrigger> & {
  label: string;
};

export function ReasoningTrigger({ className, label, ...props }: ReasoningTriggerProps) {
  return (
    <CollapsibleTrigger
      className={cn(
        "group flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground",
        className,
      )}
      {...props}
    >
      <span className="inline-flex items-center gap-2">
        <BrainIcon className="h-3.5 w-3.5" />
        {label}
      </span>
      <ChevronDownIcon className="h-4 w-4 transition-transform group-data-[state=open]:rotate-180" />
    </CollapsibleTrigger>
  );
}

export type ReasoningContentProps = ComponentProps<typeof CollapsibleContent> & {
  children: string;
};

export function ReasoningContent({ className, children, ...props }: ReasoningContentProps) {
  return (
    <CollapsibleContent className={cn("select-text px-3 pb-3 pt-0 text-sm text-muted-foreground", className)} {...props}>
      <MessageResponse>{children}</MessageResponse>
    </CollapsibleContent>
  );
}
