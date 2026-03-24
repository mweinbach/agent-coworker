import { forwardRef, type HTMLAttributes, type ReactNode } from "react";

import { ArrowDownIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";

export type ConversationProps = HTMLAttributes<HTMLDivElement>;

export const Conversation = forwardRef<HTMLDivElement, ConversationProps>(function Conversation(
  { className, ...props },
  ref,
) {
  return <div ref={ref} className={cn("relative flex-1 overflow-y-auto", className)} role="log" {...props} />;
});

export type ConversationContentProps = HTMLAttributes<HTMLDivElement>;

export function ConversationContent({ className, ...props }: ConversationContentProps) {
  return <div className={cn("mx-auto flex w-full max-w-[56rem] flex-col gap-3.5 px-4 py-5", className)} {...props} />;
}

export type ConversationEmptyStateProps = HTMLAttributes<HTMLDivElement> & {
  title?: string;
  description?: string;
  icon?: ReactNode;
};

export function ConversationEmptyState({
  className,
  title = "No messages yet",
  description = "Start the conversation to see responses here.",
  icon,
  children,
  ...props
}: ConversationEmptyStateProps) {
  return (
    <div
      className={cn("flex min-h-72 w-full flex-col items-center justify-center gap-2.5 rounded-[calc(var(--radius)*2)] border border-dashed border-border/55 bg-background/24 p-10 text-center", className)}
      {...props}
    >
      {children ?? (
        <>
          {icon ? <div className="text-muted-foreground">{icon}</div> : null}
          <h3 className="text-base font-semibold text-foreground">{title}</h3>
          <p className="max-w-lg text-sm text-muted-foreground">{description}</p>
        </>
      )}
    </div>
  );
}

export type ConversationScrollButtonProps = {
  visible: boolean;
  onClick: () => void;
};

export function ConversationScrollButton({ visible, onClick }: ConversationScrollButtonProps) {
  if (!visible) {
    return null;
  }

  return (
    <Button
      type="button"
      size="icon"
      variant="outline"
      className="absolute bottom-3.5 left-1/2 -translate-x-1/2 rounded-lg bg-card/88 backdrop-blur-sm"
      onClick={onClick}
      aria-label="Scroll to bottom"
    >
      <ArrowDownIcon data-icon="scroll" />
    </Button>
  );
}
