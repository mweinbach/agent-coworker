import type { ComponentProps, HTMLAttributes } from "react";
import type { Options as RehypeSanitizeOptions } from "rehype-sanitize";
import type { PluggableList } from "unified";

import { memo } from "react";
import {
  defaultRehypePlugins,
  defaultRemarkPlugins,
  Streamdown,
  type StreamdownProps,
} from "streamdown";
import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";

import { confirmAction, openPath } from "../../lib/desktopCommands";
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
        "select-text min-w-0 rounded-xl border border-border/80 px-4 py-3 text-sm leading-6",
        "group-[.is-user]:border-primary/35 group-[.is-user]:bg-primary group-[.is-user]:text-primary-foreground",
        "group-[.is-assistant]:bg-card/80 group-[.is-assistant]:text-foreground",
        className,
      )}
      {...props}
    />
  );
}

const streamdownPlugins = { cjk, code, math, mermaid };
const DESKTOP_LOCAL_FILE_PROTOCOL = "cowork-file:";
const desktopSanitizeSchema: RehypeSanitizeOptions = {
  ...defaultSchema,
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href ?? []), "tel", "cowork-file"],
  },
};
const defaultDesktopRehypePlugins: PluggableList = [
  defaultRehypePlugins.raw,
  [rehypeSanitize, desktopSanitizeSchema],
  defaultRehypePlugins.harden,
];

type HastNode = {
  type?: string;
  tagName?: string;
  url?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

type DesktopMessageLinkProps = ComponentProps<"a"> & {
  node?: unknown;
};

function isExternalMessageHref(rawHref: string): boolean {
  try {
    const parsed = new URL(rawHref);
    return parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "mailto:";
  } catch {
    return false;
  }
}

export function fileUrlToDesktopPath(rawHref: string): string | null {
  try {
    const parsed = new URL(rawHref);
    if (parsed.protocol !== "file:") {
      return null;
    }

    const pathname = decodeURIComponent(parsed.pathname);
    if (!pathname) {
      return null;
    }

    if (parsed.hostname && parsed.hostname !== "localhost") {
      return `\\\\${parsed.hostname}${pathname.replace(/\//g, "\\")}`;
    }

    if (/^\/[a-zA-Z]:/.test(pathname)) {
      return pathname.slice(1).replace(/\//g, "\\");
    }

    return pathname;
  } catch {
    return null;
  }
}

export function encodeDesktopLocalFileHref(rawHref: string): string | null {
  const path = fileUrlToDesktopPath(rawHref);
  if (!path) {
    return null;
  }
  return `${DESKTOP_LOCAL_FILE_PROTOCOL}//open?path=${encodeURIComponent(path)}`;
}

export function decodeDesktopLocalFileHref(rawHref?: string | null): string | null {
  if (!rawHref) {
    return null;
  }

  try {
    const parsed = new URL(rawHref);
    if (parsed.protocol !== DESKTOP_LOCAL_FILE_PROTOCOL) {
      return null;
    }
    const path = parsed.searchParams.get("path");
    return path ? path : null;
  } catch {
    return null;
  }
}

export function rewriteDesktopFileLinksInTree(node: HastNode): void {
  if (typeof node.url === "string") {
    const rewrittenUrl = encodeDesktopLocalFileHref(node.url);
    if (rewrittenUrl) {
      node.url = rewrittenUrl;
    }
  }

  if (node.type === "element" && node.tagName === "a" && typeof node.properties?.href === "string") {
    const rewrittenHref = encodeDesktopLocalFileHref(node.properties.href);
    if (rewrittenHref) {
      node.properties.href = rewrittenHref;
    }
  }

  if (!Array.isArray(node.children)) {
    return;
  }

  for (const child of node.children) {
    rewriteDesktopFileLinksInTree(child);
  }
}

export function remarkRewriteDesktopFileLinks() {
  return (tree: HastNode) => {
    rewriteDesktopFileLinksInTree(tree);
  };
}

async function openDesktopMessageLink(href: string): Promise<void> {
  const localPath = decodeDesktopLocalFileHref(href);
  if (localPath) {
    await openPath({ path: localPath });
    return;
  }

  if (isExternalMessageHref(href)) {
    const confirmed = await confirmAction({
      title: "Open external link?",
      message: "This will open the link in your default browser.",
      detail: href,
      kind: "info",
      confirmLabel: "Open link",
      cancelLabel: "Cancel",
      defaultAction: "cancel",
    });
    if (!confirmed) {
      return;
    }
  }

  window.open(href, "_blank", "noopener,noreferrer");
}

function DesktopMessageLink({
  children,
  className,
  href,
  node: _node,
  onClick,
  rel: _rel,
  target: _target,
  ...props
}: DesktopMessageLinkProps) {
  const localPath = decodeDesktopLocalFileHref(href);

  if (localPath) {
    return (
      <button
        className={cn("wrap-anywhere appearance-none bg-transparent p-0 text-left font-medium text-primary underline", className)}
        data-streamdown="link"
        onClick={(event) => {
          if (!href) {
            return;
          }
          void openDesktopMessageLink(href);
        }}
        type="button"
      >
        {children}
      </button>
    );
  }

  return (
    <a
      className={cn("wrap-anywhere font-medium text-primary underline", className)}
      data-streamdown="link"
      href={href}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented || !href || !isExternalMessageHref(href)) {
          return;
        }
        event.preventDefault();
        void openDesktopMessageLink(href);
      }}
      rel="noreferrer"
      target="_blank"
      {...props}
    >
      {children}
    </a>
  );
}

export type MessageResponseProps = StreamdownProps;

export const MessageResponse = memo(function MessageResponse({ className, ...props }: MessageResponseProps) {
  const { components, plugins, rehypePlugins, remarkPlugins, ...restProps } = props;

  return (
    <Streamdown
      {...restProps}
      className={cn(
        "[&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_a]:underline [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:border-border/80 [&_pre]:bg-muted/45 [&_pre]:p-3",
        className,
      )}
      components={{
        ...components,
        a: DesktopMessageLink,
      }}
      plugins={{
        ...streamdownPlugins,
        ...plugins,
      }}
      remarkPlugins={
        remarkPlugins ? [...remarkPlugins, remarkRewriteDesktopFileLinks] : [defaultRemarkPlugins.gfm, remarkRewriteDesktopFileLinks]
      }
      rehypePlugins={rehypePlugins ?? defaultDesktopRehypePlugins}
    />
  );
});
