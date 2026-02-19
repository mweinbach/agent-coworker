import type { HTMLAttributes } from "react";

import { memo } from "react";
import { Streamdown, type StreamdownProps } from "streamdown";
import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";

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
        "min-w-0 rounded-xl border border-border/80 px-4 py-3 text-sm leading-6",
        "group-[.is-user]:border-primary/35 group-[.is-user]:bg-primary group-[.is-user]:text-primary-foreground",
        "group-[.is-assistant]:bg-card/80 group-[.is-assistant]:text-foreground",
        className,
      )}
      {...props}
    />
  );
}

const streamdownPlugins = { cjk, code, math, mermaid };

export type MessageResponseProps = StreamdownProps;

export const MessageResponse = memo(function MessageResponse({ className, ...props }: MessageResponseProps) {
  return (
    <Streamdown
      className={cn(
        "[&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_a]:underline [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:border-border/80 [&_pre]:bg-muted/45 [&_pre]:p-3",
        className,
      )}
      plugins={streamdownPlugins}
      {...props}
    />
  );
});
