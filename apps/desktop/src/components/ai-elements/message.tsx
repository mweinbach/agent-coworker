import type { ComponentProps, HTMLAttributes } from "react";
import type { Options as RehypeSanitizeOptions } from "rehype-sanitize";
import type { PluggableList } from "unified";

import { Children, memo } from "react";
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

import { normalizeDisplayCitationMarkers } from "../../../../../src/shared/displayCitationMarkers";
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
        "select-text min-w-0 text-sm leading-6",
        "group-[.is-user]:rounded-xl group-[.is-user]:border group-[.is-user]:border-primary/35 group-[.is-user]:bg-primary group-[.is-user]:text-primary-foreground group-[.is-user]:px-4 group-[.is-user]:py-3",
        "group-[.is-assistant]:text-foreground",
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
  tagNames: [...(defaultSchema.tagNames ?? []), "sup"],
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
const bareDesktopFilePathPatterns = [
  /(?:[A-Za-z]:\\(?:[^\\\r\n<>:"|?*]+\\)*[^\\\r\n<>:"|?*]+\.[A-Za-z0-9]{1,12})(?=$|[\s),\].!?:;"'])/g,
  /(?:\\\\[^\\\r\n<>:"|?*]+\\(?:[^\\\r\n<>:"|?*]+\\)*[^\\\r\n<>:"|?*]+\.[A-Za-z0-9]{1,12})(?=$|[\s),\].!?:;"'])/g,
  /(?:\/(?:Users|home|tmp|var|opt|Applications|Volumes)(?:\/[^\/\r\n]+)+\.[A-Za-z0-9]{1,12})(?=$|[\s),\].!?:;"'])/g,
] as const;
const autoLinkSkippedNodeTypes = new Set(["code", "inlineCode", "html", "link", "linkReference"]);

type HastNode = {
  type?: string;
  tagName?: string;
  url?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

type DesktopMessageLinkProps = ComponentProps<"a"> & {
  node?: unknown;
};

type DesktopPathMatch = {
  start: number;
  end: number;
  path: string;
};

function isExternalMessageHref(rawHref: string): boolean {
  try {
    const parsed = new URL(rawHref);
    return parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "mailto:";
  } catch {
    return false;
  }
}

function desktopPathBasename(rawPath: string): string {
  const normalized = rawPath.replace(/[\\/]+$/, "").replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] || rawPath;
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

export function desktopPathToFileUrl(rawPath: string): string | null {
  const normalized = rawPath.trim();
  if (!normalized) {
    return null;
  }

  if (normalized.startsWith("\\\\")) {
    const parts = normalized.slice(2).split("\\").filter(Boolean);
    const [host, ...rest] = parts;
    if (!host || rest.length === 0) {
      return null;
    }
    return `file://${host}/${rest.map((part) => encodeURIComponent(part)).join("/")}`;
  }

  const slashPath = normalized.replace(/\\/g, "/");
  if (/^[A-Za-z]:\//.test(slashPath)) {
    const [drive, ...rest] = slashPath.split("/");
    return `file:///${drive}/${rest.map((part) => encodeURIComponent(part)).join("/")}`;
  }

  if (!slashPath.startsWith("/")) {
    return null;
  }

  return `file:///${slashPath
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/")}`;
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

function normalizeDesktopFileLinkLabel(node: HastNode, desktopPath: string, rawHref: string): void {
  if (!Array.isArray(node.children) || node.children.length !== 1) {
    return;
  }

  const [onlyChild] = node.children;
  if (onlyChild?.type !== "text" || typeof onlyChild.value !== "string") {
    return;
  }

  const candidate = onlyChild.value.trim();
  const normalizedDesktopPath = desktopPath.replace(/\\/g, "/");
  if (candidate === desktopPath || candidate === normalizedDesktopPath || candidate === rawHref) {
    onlyChild.value = desktopPathBasename(desktopPath);
  }
}

function isAutoLinkSkippedNode(node: HastNode): boolean {
  if (autoLinkSkippedNodeTypes.has(node.type ?? "")) {
    return true;
  }

  return node.type === "element" && (node.tagName === "a" || node.tagName === "code" || node.tagName === "pre");
}

function findBareDesktopFilePathMatches(text: string): DesktopPathMatch[] {
  const matches: DesktopPathMatch[] = [];

  for (const pattern of bareDesktopFilePathPatterns) {
    for (const match of text.matchAll(pattern)) {
      if (typeof match.index !== "number") {
        continue;
      }

      matches.push({
        start: match.index,
        end: match.index + match[0].length,
        path: match[0],
      });
    }
  }

  matches.sort((left, right) => left.start - right.start || (right.end - right.start) - (left.end - left.start));

  const deduped: DesktopPathMatch[] = [];
  for (const match of matches) {
    const previous = deduped[deduped.length - 1];
    if (previous && match.start < previous.end) {
      continue;
    }
    deduped.push(match);
  }

  return deduped;
}

function buildBareDesktopPathNodes(text: string): HastNode[] | null {
  const matches = findBareDesktopFilePathMatches(text);
  if (matches.length === 0) {
    return null;
  }

  const nodes: HastNode[] = [];
  let cursor = 0;

  for (const match of matches) {
    if (match.start > cursor) {
      nodes.push({ type: "text", value: text.slice(cursor, match.start) });
    }

    const fileUrl = desktopPathToFileUrl(match.path);
    if (fileUrl) {
      nodes.push({
        type: "link",
        url: fileUrl,
        children: [{ type: "text", value: desktopPathBasename(match.path) }],
      });
    } else {
      nodes.push({ type: "text", value: text.slice(match.start, match.end) });
    }

    cursor = match.end;
  }

  if (cursor < text.length) {
    nodes.push({ type: "text", value: text.slice(cursor) });
  }

  return nodes.filter((node) => node.type !== "text" || Boolean(node.value));
}

export function rewriteBareDesktopFilePathsInTree(node: HastNode): void {
  if (isAutoLinkSkippedNode(node) || !Array.isArray(node.children)) {
    return;
  }

  const nextChildren: HastNode[] = [];
  for (const child of node.children) {
    if (child.type === "text" && typeof child.value === "string") {
      const rewrittenNodes = buildBareDesktopPathNodes(child.value);
      if (rewrittenNodes) {
        nextChildren.push(...rewrittenNodes);
        continue;
      }
    }

    // Convert inlineCode nodes that are entirely a file path into a clickable link
    if (child.type === "inlineCode" && typeof child.value === "string") {
      const trimmed = child.value.trim();
      const matches = findBareDesktopFilePathMatches(trimmed);
      if (matches.length === 1 && matches[0].start === 0 && matches[0].end === trimmed.length) {
        const fileUrl = desktopPathToFileUrl(matches[0].path);
        if (fileUrl) {
          nextChildren.push({
            type: "link",
            url: fileUrl,
            children: [{ type: "text", value: desktopPathBasename(matches[0].path) }],
          });
          continue;
        }
      }
    }

    rewriteBareDesktopFilePathsInTree(child);
    nextChildren.push(child);
  }

  node.children = nextChildren;
}

export function rewriteDesktopFileLinksInTree(node: HastNode): void {
  if (typeof node.url === "string") {
    const desktopPath = fileUrlToDesktopPath(node.url);
    if (desktopPath) {
      normalizeDesktopFileLinkLabel(node, desktopPath, node.url);
    }

    const rewrittenUrl = encodeDesktopLocalFileHref(node.url);
    if (rewrittenUrl) {
      node.url = rewrittenUrl;
    }
  }

  if (node.type === "element" && node.tagName === "a" && typeof node.properties?.href === "string") {
    const href = node.properties.href;
    const desktopPath = fileUrlToDesktopPath(href);
    if (desktopPath) {
      normalizeDesktopFileLinkLabel(node, desktopPath, href);
    }

    const rewrittenHref = encodeDesktopLocalFileHref(href);
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
    rewriteBareDesktopFilePathsInTree(tree);
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

export type MessageResponseProps = StreamdownProps & {
  normalizeDisplayCitations?: boolean;
  citationUrlsByIndex?: ReadonlyMap<number, string>;
  citationAnnotations?: unknown;
  fallbackToSourcesFooter?: boolean;
};

function normalizeMessageResponseChildren(
  children: StreamdownProps["children"],
  normalizeDisplayCitations: boolean,
  citationUrlsByIndex?: ReadonlyMap<number, string>,
  citationAnnotations?: unknown,
  fallbackToSourcesFooter = true,
): StreamdownProps["children"] {
  if (!normalizeDisplayCitations) {
    return children;
  }

  if (typeof children === "string") {
    return normalizeDisplayCitationMarkers(children, {
      citationUrlsByIndex,
      citationMode: "html",
      annotations: citationAnnotations,
      fallbackToSourcesFooter,
    });
  }

  return Children.map(children, (child) => typeof child === "string"
    ? normalizeDisplayCitationMarkers(child, {
      citationUrlsByIndex,
      citationMode: "html",
      annotations: citationAnnotations,
      fallbackToSourcesFooter,
    })
    : child);
}

export const MessageResponse = memo(function MessageResponse({
  className,
  citationUrlsByIndex,
  citationAnnotations,
  normalizeDisplayCitations = false,
  fallbackToSourcesFooter = true,
  ...props
}: MessageResponseProps) {
  const { children, components, plugins, rehypePlugins, remarkPlugins, ...restProps } = props;

  return (
    <Streamdown
      {...restProps}
      children={normalizeMessageResponseChildren(
        children,
        normalizeDisplayCitations,
        citationUrlsByIndex,
        citationAnnotations,
        fallbackToSourcesFooter,
      )}
      className={cn(
        "[&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_a]:underline [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:border-border/80 [&_pre]:bg-muted/45 [&_pre]:p-3 [&_sup]:ml-0.5 [&_sup]:align-super [&_sup]:text-[0.72em] [&_sup]:leading-none [&_sup_a]:font-medium [&_sup_a]:text-primary [&_sup_a]:no-underline hover:[&_sup_a]:underline",
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
