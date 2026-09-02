import * as React from "react";
import { cn } from "@/lib/utils";

function MessageScrollerProvider({ children }: React.PropsWithChildren) {
  return <>{children}</>;
}

const MessageScroller = React.forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<"div">>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      data-slot="message-scroller"
      className={cn(
        "group/message-scroller relative flex size-full min-h-0 flex-col overflow-hidden",
        className,
      )}
      {...props}
    />
  ),
);
MessageScroller.displayName = "MessageScroller";

const MessageScrollerViewport = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<"div">
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    data-slot="message-scroller-viewport"
    className={cn(
      "size-full min-h-0 min-w-0 scroll-fade-b scrollbar-thin scrollbar-gutter-stable overflow-y-auto overscroll-contain contain-content data-autoscrolling:scrollbar-none",
      className,
    )}
    {...props}
  />
));
MessageScrollerViewport.displayName = "MessageScrollerViewport";

const MessageScrollerContent = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<"div">
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    data-slot="message-scroller-content"
    className={cn("flex h-max min-h-full flex-col gap-8", className)}
    {...props}
  />
));
MessageScrollerContent.displayName = "MessageScrollerContent";

type MessageScrollerItemProps = React.ComponentPropsWithoutRef<"div"> & {
  messageId?: string;
  scrollAnchor?: boolean | string;
};

const MessageScrollerItem = React.forwardRef<HTMLDivElement, MessageScrollerItemProps>(
  ({ className, messageId, scrollAnchor = false, ...props }, ref) => {
    const scrollAnchorId = typeof scrollAnchor === "string" ? scrollAnchor : undefined;

    return (
      <div
        ref={ref}
        data-slot="message-scroller-item"
        data-message-id={messageId}
        data-scroll-anchor-id={scrollAnchorId}
        className={cn(
          // Avoid content-visibility + fixed intrinsic size: variable-height chat
          // rows (markdown, activity timelines) jump the scroll position when the
          // browser swaps estimate → real height. ChatFeed progressive windowing
          // keeps only a trailing slice mounted instead.
          "min-w-0 shrink-0",
          className,
        )}
        {...props}
      />
    );
  },
);
MessageScrollerItem.displayName = "MessageScrollerItem";

export {
  MessageScroller,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
};
