import { forwardRef, type HTMLAttributes } from "react";

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
  return <div className={cn("mx-auto flex w-full max-w-4xl flex-col gap-4 px-5 py-6", className)} {...props} />;
}

export type ConversationEmptyStateProps = HTMLAttributes<HTMLDivElement> & {
  title?: string;
  description?: string;
};

export function ConversationEmptyState({
  className,
  title = "No messages yet",
  description = "Start the conversation to see responses here.",
  children,
  ...props
}: ConversationEmptyStateProps) {
  return (
    <div
      className={cn("flex min-h-80 w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border/70 p-8 text-center", className)}
      {...props}
    >
      {children ?? (
        <>
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
      className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-card/90 backdrop-blur"
      onClick={onClick}
      aria-label="Scroll to bottom"
    >
      <ArrowDownIcon className="h-4 w-4" />
    </Button>
  );
}
