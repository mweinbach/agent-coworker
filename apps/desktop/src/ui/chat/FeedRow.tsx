import {
  AlertCircleIcon,
  CheckIcon,
  CopyIcon,
  FileAudioIcon,
  FileIcon,
  FileImageIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  FileVideoIcon,
  Table2Icon,
} from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import type { CitationSource } from "../../../../../src/shared/displayCitationMarkers";
import { extractCitationUrlsFromAnnotations } from "../../../../../src/shared/displayCitationMarkers";
import type { FeedItem } from "../../app/types";
import {
  Attachment,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
} from "../../components/ui/attachment";
import { Bubble, BubbleContent } from "../../components/ui/bubble";
import { Button } from "../../components/ui/button";
import { Card, CardContent } from "../../components/ui/card";
import { Marker, MarkerContent } from "../../components/ui/marker";
import { Message, MessageContent } from "../../components/ui/message";
import { copyText as writeClipboardText } from "../../lib/desktopCommands";
import {
  encodeDesktopMediaUrl,
  isAbsoluteDesktopPath,
  isDesktopMediaImagePath,
} from "../../lib/mediaProtocol";
import { openExternalSource } from "../../lib/openExternalSource";
import { cn } from "../../lib/utils";
import { DesktopMarkdown, rewriteDesktopImageUrl } from "../markdown";
import { recordDesktopRenderMetric } from "../renderDiagnostics";
import { useChatViewContext } from "./ChatViewContext";
import { CitationSourcesCarousel } from "./CitationSourcesCarousel";
import type { MentionCatalog } from "./composerMentions";
import {
  buildVisibleUserMessage,
  type CanvasRequest,
  canvasFallbackName,
  type VisibleUserAttachment,
} from "./feedMessageParsing";
import { MentionText } from "./MentionText";
import { ToolCard } from "./toolCards/ToolCard";

type CopyStatus = "idle" | "copied" | "failed";

function copyStatusLabel(status: CopyStatus, idleLabel: string): string {
  switch (status) {
    case "idle":
      return idleLabel;
    case "copied":
      return "Copied";
    case "failed":
      return "Copy failed. Retry.";
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

function copyButtonCaption(status: CopyStatus): string {
  switch (status) {
    case "idle":
      return "Copy";
    case "copied":
      return "Copied";
    case "failed":
      return "Retry";
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

function copyStatusSrOnly(status: CopyStatus): string {
  switch (status) {
    case "idle":
      return "Copy";
    case "copied":
      return "Copied";
    case "failed":
      return "Copy failed. Retry.";
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}
function copyLiveAnnouncement(status: CopyStatus): string {
  switch (status) {
    case "idle":
      return "";
    case "copied":
      return "Copied";
    case "failed":
      return "Couldn't copy message. Try again.";
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}
function CopyStatusIcon(props: { status: CopyStatus }) {
  switch (props.status) {
    case "copied":
      return <CheckIcon data-icon="inline-start" className="text-success" />;
    case "failed":
      return <AlertCircleIcon data-icon="inline-start" className="text-destructive" />;
    case "idle":
      return <CopyIcon data-icon="inline-start" />;
    default: {
      const _exhaustive: never = props.status;
      return _exhaustive;
    }
  }
}

function useClipboardCopy() {
  const [status, setStatus] = useState<CopyStatus>("idle");
  const copyTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current !== null) {
        window.clearTimeout(copyTimeoutRef.current);
      }
    };
  }, []);

  const copy = async (text: string) => {
    try {
      await writeClipboardText(text);
      setStatus("copied");
      if (copyTimeoutRef.current !== null) {
        window.clearTimeout(copyTimeoutRef.current);
      }
      copyTimeoutRef.current = window.setTimeout(() => setStatus("idle"), 1500);
    } catch {
      if (copyTimeoutRef.current !== null) {
        window.clearTimeout(copyTimeoutRef.current);
        copyTimeoutRef.current = null;
      }
      setStatus("failed");
    }
  };

  return { status, copy };
}

function MessageCopyAction(props: { text: string; className?: string }) {
  const { status, copy } = useClipboardCopy();
  const label = copyStatusLabel(status, "Copy message");

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      onClick={() => {
        void copy(props.text);
      }}
      aria-label={label}
      title={label}
      className={cn(
        "opacity-0 transition-opacity duration-150 focus-visible:opacity-100 group-hover/message:opacity-100 group-focus-within/message:opacity-100",
        status !== "idle" && "opacity-100",
        props.className,
      )}
    >
      <CopyStatusIcon status={status} />
      <span className="sr-only">{copyStatusSrOnly(status)}</span>
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {copyLiveAnnouncement(status)}
      </span>
    </Button>
  );
}

function ErrorFeedRow(props: { message: string }) {
  const { status, copy } = useClipboardCopy();
  const [expanded, setExpanded] = useState(false);
  const copyLabel = copyStatusLabel(status, "Copy error");
  return (
    <Card
      role="alert"
      aria-live="assertive"
      aria-atomic="true"
      className="w-full min-w-0 overflow-hidden border-destructive/40 bg-destructive/10"
    >
      <CardContent className="select-text p-3 text-sm">
        <div className="mb-1 flex items-center justify-between gap-2">
          <div className="font-semibold uppercase tracking-wide text-destructive">Error</div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => {
                void copy(props.message);
              }}
              aria-label={copyLabel}
              title={copyLabel}
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {status === "copied" ? (
                <CheckIcon className="size-3 text-success" />
              ) : status === "failed" ? (
                <AlertCircleIcon className="size-3 text-destructive" />
              ) : (
                <CopyIcon className="size-3" />
              )}
              {copyButtonCaption(status)}
            </button>
            <button
              type="button"
              onClick={() => setExpanded((e) => !e)}
              aria-label={expanded ? "Collapse" : "Show full error"}
              aria-expanded={expanded}
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {expanded ? "Less" : "More"}
            </button>
          </div>
        </div>
        <div
          className={cn(
            "whitespace-pre-wrap break-words [overflow-wrap:anywhere]",
            expanded ? "max-h-none" : "max-h-72 overflow-auto",
          )}
        >
          {props.message}
        </div>
      </CardContent>
    </Card>
  );
}

export function CanvasRequestBody(props: { request: CanvasRequest; catalog: MentionCatalog }) {
  const { request, catalog } = props;
  const FileGlyph = request.surface === "spreadsheet" ? FileSpreadsheetIcon : FileTextIcon;
  const fallbackName = canvasFallbackName(request.surface);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5 select-none">
        <span className="inline-flex min-w-0 items-center gap-1 rounded-md border border-primary/25 bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-foreground/90">
          <FileGlyph className="size-3 shrink-0 text-primary/80" />
          <span className="max-w-[200px] truncate" title={request.fileName ?? fallbackName}>
            {request.fileName ?? fallbackName}
          </span>
        </span>
        {request.sheet ? (
          <span className="inline-flex items-center gap-1 rounded-md bg-muted/50 px-1.5 py-0.5 text-xs text-muted-foreground">
            <Table2Icon className="size-3 shrink-0" />
            {request.sheet}
          </span>
        ) : null}
        {request.region ? (
          <span className="inline-flex items-center rounded-md bg-muted/50 px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
            {request.region}
          </span>
        ) : null}
      </div>
      {request.selectionText ? (
        <div
          className="line-clamp-3 rounded-md border border-border/40 bg-muted/30 px-2 py-1 text-xs italic text-muted-foreground"
          title={request.selectionText}
        >
          {`\u201C${request.selectionText}\u201D`}
        </div>
      ) : null}
      {request.userRequest ? (
        <div className="text-foreground">
          <MentionText text={request.userRequest} catalog={catalog} />
        </div>
      ) : null}
    </div>
  );
}

function attachmentIconForFilename(fileName: string) {
  if (/\.(mp3|wav|ogg|m4a|aac|flac)$/i.test(fileName)) return FileAudioIcon;
  if (/\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i.test(fileName)) return FileImageIcon;
  if (/\.(mp4|mov|avi|mkv|webm)$/i.test(fileName)) return FileVideoIcon;
  if (/\.pdf$/i.test(fileName)) return FileTextIcon;
  return FileIcon;
}

function attachmentTypeForFilename(fileName: string): string {
  const extension = fileName.trim().split(".").at(-1);
  return extension && extension !== fileName ? extension.toUpperCase() : "FILE";
}

const WORKSPACE_UPLOADS_DIR = "User Uploads";
const URL_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

function hasUnsafeAttachmentPreviewScheme(fileName: string): boolean {
  const trimmed = fileName.trim();
  if (!trimmed) return true;
  return URL_SCHEME_RE.test(trimmed) && !isAbsoluteDesktopPath(trimmed);
}

function isSafeAttachmentPreviewSrc(src: string): boolean {
  return src.startsWith("cowork-media:");
}

export function resolveUserAttachmentPreviewSrc(
  fileName: string,
  desktopBasePath?: string | null,
): string | null {
  if (!isDesktopMediaImagePath(fileName) || hasUnsafeAttachmentPreviewScheme(fileName)) {
    return null;
  }

  const absolute = encodeDesktopMediaUrl(fileName);
  if (absolute && isSafeAttachmentPreviewSrc(absolute)) return absolute;
  if (!desktopBasePath) return null;

  const normalized = fileName.replace(/\\/g, "/");
  const candidates =
    normalized.includes("/") || normalized.includes(":")
      ? [normalized]
      : [`${WORKSPACE_UPLOADS_DIR}/${normalized}`, normalized];

  for (const candidate of candidates) {
    const rewritten = rewriteDesktopImageUrl(candidate, desktopBasePath);
    if (rewritten && isSafeAttachmentPreviewSrc(rewritten)) return rewritten;
  }
  return null;
}

function keyedAttachmentFileNames(fileNames: readonly string[]) {
  const occurrences = new Map<string, number>();
  return fileNames.map((fileName) => {
    const occurrence = occurrences.get(fileName) ?? 0;
    occurrences.set(fileName, occurrence + 1);
    return { fileName, key: `${fileName}:${occurrence}` };
  });
}

function UserAttachmentGroup(props: {
  attachments: readonly VisibleUserAttachment[];
  desktopBasePath?: string | null;
}) {
  if (props.attachments.length === 0) return null;
  const fileNames = props.attachments.map((attachment) => attachment.fileName);
  return (
    <AttachmentGroup className="max-w-full" aria-label="Attached files">
      {keyedAttachmentFileNames(fileNames).map(({ fileName, key }, index) => {
        const attachment = props.attachments[index];
        const displayName = attachment?.displayName ?? fileName;
        const previewSrc = resolveUserAttachmentPreviewSrc(fileName, props.desktopBasePath);
        const IconComponent = attachmentIconForFilename(displayName);
        return (
          <Attachment key={key} size="sm">
            <AttachmentMedia variant={previewSrc ? "image" : "icon"}>
              {previewSrc ? (
                <img src={previewSrc} alt="" className="size-full object-cover" draggable={false} />
              ) : (
                <IconComponent />
              )}
            </AttachmentMedia>
            <AttachmentContent>
              <AttachmentTitle title={displayName}>{displayName}</AttachmentTitle>
              <AttachmentDescription>
                {attachmentTypeForFilename(displayName)}
              </AttachmentDescription>
            </AttachmentContent>
          </Attachment>
        );
      })}
    </AttachmentGroup>
  );
}

export const FeedRow = memo(function FeedRow(props: {
  item: FeedItem;
  citationUrlsByIndex?: ReadonlyMap<number, string>;
  citationSources?: CitationSource[];
  desktopBasePath?: string | null;
  isStreaming?: boolean;
}) {
  const { developerMode, mentionCatalog } = useChatViewContext();
  const item = props.item;
  recordDesktopRenderMetric("feed-row", item.id);
  const hasSources = props.citationSources && props.citationSources.length > 0;
  const hasInlineCitationChip =
    item.kind === "message" &&
    item.role === "assistant" &&
    extractCitationUrlsFromAnnotations(item.annotations).size > 0;

  if (item.kind === "message") {
    if (item.role === "user") {
      // action special rendering removed (feature fully stripped)
    }

    const visibleUserMessage = item.role === "user" ? buildVisibleUserMessage(item.text) : null;
    const copyText = visibleUserMessage?.copyText ?? item.text;
    const isStreamingAssistant = item.role === "assistant" && props.isStreaming === true;
    if (isStreamingAssistant) {
      recordDesktopRenderMetric("streaming-markdown", item.id);
    }

    return (
      <Message
        role="article"
        aria-label={item.role === "user" ? "Message from you" : "Message from Cowork"}
        aria-busy={isStreamingAssistant || undefined}
        align={item.role === "user" ? "end" : "start"}
      >
        <MessageContent className="relative">
          {item.role === "assistant" ? (
            <Bubble variant="ghost" align="start">
              <BubbleContent className="text-[15px] leading-[1.65]">
                <div data-slot={isStreamingAssistant ? "streaming-markdown" : "markdown"}>
                  <DesktopMarkdown
                    citationAnnotations={item.annotations}
                    citationSources={props.citationSources}
                    citationUrlsByIndex={props.citationUrlsByIndex}
                    caret="block"
                    desktopBasePath={props.desktopBasePath}
                    normalizeDisplayCitations
                    fallbackToSourcesFooter={!hasSources}
                    isAnimating={isStreamingAssistant}
                    mode={isStreamingAssistant ? "streaming" : "static"}
                    parseIncompleteMarkdown={isStreamingAssistant}
                  >
                    {item.text}
                  </DesktopMarkdown>
                </div>
              </BubbleContent>
            </Bubble>
          ) : (
            <Bubble
              variant="tinted"
              align="end"
              className="*:data-[slot=bubble-content]:border-primary/15 *:data-[slot=bubble-content]:bg-primary/[0.07] dark:*:data-[slot=bubble-content]:border-primary/20 dark:*:data-[slot=bubble-content]:bg-primary/[0.10]"
            >
              <BubbleContent className="cursor-text select-text rounded-2xl rounded-br-md px-3.5 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap selection:bg-primary/20">
                <div className="flex flex-col gap-2">
                  {visibleUserMessage?.canvas ? (
                    <CanvasRequestBody
                      request={visibleUserMessage.canvas}
                      catalog={mentionCatalog}
                    />
                  ) : visibleUserMessage?.bodyText ? (
                    <MentionText text={visibleUserMessage.bodyText} catalog={mentionCatalog} />
                  ) : null}
                  {visibleUserMessage && visibleUserMessage.attachments.length > 0 ? (
                    <UserAttachmentGroup
                      attachments={visibleUserMessage.attachments}
                      desktopBasePath={props.desktopBasePath}
                    />
                  ) : null}
                </div>
              </BubbleContent>
            </Bubble>
          )}

          {hasSources && !hasInlineCitationChip && props.citationSources ? (
            <CitationSourcesCarousel
              sources={props.citationSources}
              onOpenSource={openExternalSource}
            />
          ) : null}

          {copyText ? (
            <div
              className={cn(
                "pointer-events-none -mt-2 flex h-6 items-center",
                item.role === "user" ? "justify-end" : "justify-start",
              )}
              data-slot="message-actions"
            >
              <div className="pointer-events-auto">
                <MessageCopyAction text={copyText} />
              </div>
            </div>
          ) : null}
        </MessageContent>
      </Message>
    );
  }

  if (item.kind === "reasoning") {
    return null;
  }

  if (item.kind === "todos") {
    return null;
  }

  if (item.kind === "tool") {
    return (
      <ToolCard
        name={item.name}
        args={item.args}
        approval={item.approval}
        result={item.result}
        state={item.state}
      />
    );
  }

  if (item.kind === "log") {
    if (!developerMode) return null;
    return (
      <Marker variant="border" className="select-text items-start">
        <MarkerContent
          role="log"
          aria-label="Developer log"
          aria-live="off"
          className="flex flex-col gap-1 text-xs"
        >
          <span className="font-semibold uppercase tracking-wide text-primary">Log</span>
          <span className="whitespace-pre-wrap">{item.line}</span>
        </MarkerContent>
      </Marker>
    );
  }

  if (item.kind === "error") {
    return <ErrorFeedRow message={item.message} />;
  }

  if (item.kind === "system") {
    return (
      <Marker variant="border" className="select-text items-start">
        <MarkerContent role="status" className="flex flex-col gap-1 text-xs">
          <span className="font-semibold uppercase tracking-wide text-primary">System</span>
          <span className="whitespace-pre-wrap">{item.line}</span>
        </MarkerContent>
      </Marker>
    );
  }

  return null;
});
