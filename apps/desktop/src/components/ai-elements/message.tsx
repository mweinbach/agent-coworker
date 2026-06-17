import type { HTMLAttributes } from "react";
import { memo } from "react";
import { Streamdown, type StreamdownProps } from "streamdown";

import { cn } from "../../lib/utils";

export type MessageProps = HTMLAttributes<HTMLDivElement> & {
  from: "user" | "assistant";
};

export function Message({ className, from, ...props }: MessageProps) {
  return (
    <div
      className={cn(
        "group flex w-full max-w-[95%] flex-col gap-2",
        from === "user" ? "is-user ml-auto" : "is-assistant mr-auto",
        className,
      )}
      {...props}
    />
  );
}

export type MessageContentProps = HTMLAttributes<HTMLDivElement>;

export function MessageContent({ className, ...props }: MessageContentProps) {
  return (
    <div
      className={cn(
        "select-text min-w-0 text-sm leading-6 break-words",
        "group-[.is-user]:rounded-2xl group-[.is-user]:border group-[.is-user]:border-primary/22 group-[.is-user]:bg-primary/12 group-[.is-user]:px-3 group-[.is-user]:py-2 group-[.is-user]:text-foreground group-[.is-user]:leading-relaxed",
        "group-[.is-assistant]:text-foreground",
        className,
      )}
      {...props}
    />
  );
}

export type MessageResponseProps = StreamdownProps;

/**
 * Pure presentational markdown renderer: a styled Streamdown wrapper. It carries
 * only prose styling and forwards every Streamdown prop. All desktop behavior
 * (file links, citation chips, sanitize pipeline) is layered on at the
 * implementation point — see `src/ui/markdown/DesktopMarkdown`.
 */
export const MessageResponse = memo(function MessageResponse({
  className,
  ...props
}: MessageResponseProps) {
  return (
    <Streamdown
      {...props}
      className={cn(
        "select-text [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_a]:underline [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-5 [&_li]:my-1.5 [&_li]:pl-1 [&_li::marker]:text-muted-foreground [&_li>p]:my-1 [&_li>p:first-child]:mt-0 [&_li>p:last-child]:mb-0 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:border-border/80 [&_pre]:bg-muted/45 [&_pre]:p-3 [&_sup]:ml-0.5 [&_sup]:align-super [&_sup]:text-[0.72em] [&_sup]:leading-none [&_sup_a]:font-medium [&_sup_a]:text-primary [&_sup_a]:no-underline hover:[&_sup_a]:underline",
        className,
      )}
    />
  );
});
