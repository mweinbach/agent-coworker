import { ArrowDownIcon } from "lucide-react";
import { forwardRef, type HTMLAttributes, type ReactNode } from "react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";

export type ConversationProps = HTMLAttributes<HTMLDivElement>;

export const Conversation = forwardRef<HTMLDivElement, ConversationProps>(function Conversation(
  { className, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn("relative flex-1 overflow-y-auto", className)}
      role="log"
      {...props}
    />
  );
});

export type ConversationContentProps = HTMLAttributes<HTMLDivElement>;

export function ConversationContent({ className, ...props }: ConversationContentProps) {
  return (
    <div
      className={cn("mx-auto flex w-full max-w-[56rem] flex-col gap-3.5 px-4 py-5", className)}
      {...props}
    />
  );
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
      className={cn(
        "flex min-h-72 w-full flex-col items-center justify-center gap-2.5 rounded-[calc(var(--radius)*2)] border border-dashed border-border/55 bg-background/24 p-10 text-center",
        className,
      )}
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
  bottomOffset?: number;
  visible: boolean;
  onClick: () => void;
};

export function ConversationScrollButton({
  bottomOffset,
  visible,
  onClick,
}: ConversationScrollButtonProps) {
  if (!visible) {
    return null;
  }

  const peerBottom = bottomOffset === undefined ? undefined : bottomOffset - 14;

  return (
    <>
      <div
        className="absolute left-1/2 z-30 -translate-x-1/2 peer w-24 h-16 pointer-events-auto"
        style={
          peerBottom === undefined
            ? { bottom: "4px" }
            : {
                bottom: peerBottom,
              }
        }
      />
      <Button
        type="button"
        size="icon"
        variant="outline"
        className={cn(
          "absolute left-1/2 z-30 -translate-x-1/2 rounded-full border border-border/40 bg-background/80 hover:bg-background/95 hover:text-foreground text-muted-foreground shadow-md backdrop-blur-md transition-all duration-300 hover:scale-110 active:scale-95 size-9 opacity-60 scale-90 pointer-events-auto hover:opacity-100 hover:scale-100 peer-hover:opacity-100 peer-hover:scale-100 focus-visible:opacity-100 focus-visible:scale-100",
          bottomOffset === undefined && "bottom-3.5",
        )}
        style={bottomOffset === undefined ? undefined : { bottom: bottomOffset }}
        onClick={onClick}
        aria-label="Scroll to bottom"
      >
        <ArrowDownIcon className="size-4" data-icon="scroll" />
      </Button>
    </>
  );
}
