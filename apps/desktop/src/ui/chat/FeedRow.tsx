import {
  CheckCircle2Icon,
  CheckIcon,
  CircleDashedIcon,
  CircleIcon,
  ClipboardListIcon,
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
import {
  encodeDesktopMediaUrl,
  isAbsoluteDesktopPath,
  isDesktopMediaImagePath,
} from "../../lib/mediaProtocol";
import { openExternalSource } from "../../lib/openExternalSource";
import { cn } from "../../lib/utils";
import { DesktopMarkdown } from "../markdown";
import { useChatViewContext } from "./ChatViewContext";
import { CitationSourcesCarousel } from "./CitationSourcesCarousel";
import type { MentionCatalog } from "./composerMentions";
import {
  type CanvasRequest,
  parseCanvasRequest,
  parseUserMessageAttachments,
} from "./feedMessageParsing";
import { MentionText } from "./MentionText";
import { ToolCard } from "./toolCards/ToolCard";

function MessageCopyAction(props: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const copyTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current !== null) {
        window.clearTimeout(copyTimeoutRef.current);
      }
    };
  }, []);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(props.text);
      setCopied(true);
      if (copyTimeoutRef.current !== null) {
        window.clearTimeout(copyTimeoutRef.current);
      }
      copyTimeoutRef.current = window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard may be unavailable (permissions, non-secure context). Fail silently.
    }
  };
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      onClick={handleCopy}
      aria-label={copied ? "Copied" : "Copy message"}
      className={cn(
        "bg-background/90 shadow-sm backdrop-blur-sm opacity-0 transition-opacity duration-150 focus-visible:opacity-100 group-hover/message:opacity-100 group-focus-within/message:opacity-100",
        props.className,
      )}
    >
      {copied ? (
        <CheckIcon data-icon="inline-start" className="text-success" />
      ) : (
        <CopyIcon data-icon="inline-start" />
      )}
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}

function ErrorFeedRow(props: { message: string }) {
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const copyTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current !== null) {
        window.clearTimeout(copyTimeoutRef.current);
      }
    };
  }, []);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(props.message);
      setCopied(true);
      if (copyTimeoutRef.current !== null) {
        window.clearTimeout(copyTimeoutRef.current);
      }
      copyTimeoutRef.current = window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable — fail silently.
    }
  };
  return (
    <Card className="w-full min-w-0 overflow-hidden border-destructive/40 bg-destructive/10">
      <CardContent className="select-text p-3 text-sm">
        <div className="mb-1 flex items-center justify-between gap-2">
          <div className="font-semibold uppercase tracking-wide text-destructive">Error</div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={handleCopy}
              aria-label={copied ? "Copied" : "Copy error"}
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              {copied ? (
                <CheckIcon className="size-3 text-success" />
              ) : (
                <CopyIcon className="size-3" />
              )}
              {copied ? "Copied" : "Copy"}
            </button>
            <button
              type="button"
              onClick={() => setExpanded((e) => !e)}
              aria-label={expanded ? "Collapse" : "Show full error"}
              aria-expanded={expanded}
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
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
  const fallbackName = request.surface === "spreadsheet" ? "Spreadsheet" : "Document";

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5 select-none">
        <span className="inline-flex min-w-0 items-center gap-1 rounded-md border border-primary/25 bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-foreground/90">
          <FileGlyph className="size-3 shrink-0 text-primary/80" />
          <span className="max-w-[200px] truncate" title={request.fileName ?? undefined}>
            {request.fileName ?? fallbackName}
          </span>
        </span>
        {request.sheet ? (
          <span className="inline-flex items-center gap-1 rounded-md bg-muted/50 px-1.5 py-0.5 text-[11px] text-muted-foreground">
            <Table2Icon className="size-3 shrink-0" />
            {request.sheet}
          </span>
        ) : null}
        {request.region ? (
          <span className="inline-flex items-center rounded-md bg-muted/50 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
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
  if (/\.(png|jpe?g|gif|webp|svg)$/i.test(fileName)) return FileImageIcon;
  if (/\.(mp4|mov|avi|mkv|webm)$/i.test(fileName)) return FileVideoIcon;
  if (/\.pdf$/i.test(fileName)) return FileTextIcon;
  return FileIcon;
}

function attachmentTypeForFilename(fileName: string): string {
  const extension = fileName.trim().split(".").at(-1);
  return extension && extension !== fileName ? extension.toUpperCase() : "FILE";
}

function attachmentPreviewSrc(fileName: string): string | null {
  if (!isAbsoluteDesktopPath(fileName) || !isDesktopMediaImagePath(fileName)) {
    return null;
  }
  return encodeDesktopMediaUrl(fileName);
}

function keyedAttachmentFileNames(fileNames: readonly string[]) {
  const occurrences = new Map<string, number>();
  return fileNames.map((fileName) => {
    const occurrence = occurrences.get(fileName) ?? 0;
    occurrences.set(fileName, occurrence + 1);
    return { fileName, key: `${fileName}:${occurrence}` };
  });
}

function UserAttachmentGroup(props: { fileNames: readonly string[] }) {
  if (props.fileNames.length === 0) return null;
  return (
    <AttachmentGroup className="max-w-full">
      {keyedAttachmentFileNames(props.fileNames).map(({ fileName, key }) => {
        const previewSrc = attachmentPreviewSrc(fileName);
        const IconComponent = attachmentIconForFilename(fileName);
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
              <AttachmentTitle title={fileName}>{fileName}</AttachmentTitle>
              <AttachmentDescription>{attachmentTypeForFilename(fileName)}</AttachmentDescription>
            </AttachmentContent>
          </Attachment>
        );
      })}
    </AttachmentGroup>
  );
}

function resolveUserCopyText(opts: {
  canvasRequest: CanvasRequest | null;
  cleanText: string;
  rawText: string;
}): string {
  if (opts.canvasRequest) {
    return opts.canvasRequest.userRequest || opts.cleanText || opts.rawText;
  }
  return opts.cleanText || opts.rawText;
}

function FeedTodosCard(props: { todos: Extract<FeedItem, { kind: "todos" }>["todos"] }) {
  const todos = props.todos;
  if (todos.length === 0) return null;
  const completed = todos.filter((todo) => todo.status === "completed").length;
  return (
    <Card className="max-w-3xl gap-0 rounded-xl border border-border/45 bg-muted/[0.08] p-0 shadow-none">
      <CardContent className="flex flex-col gap-2 p-3">
        <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          <ClipboardListIcon className="size-3.5" />
          <span>Plan</span>
          <span className="font-medium normal-case tracking-normal text-muted-foreground/80">
            {completed}/{todos.length}
          </span>
        </div>
        <div className="flex flex-col gap-1.5">
          {todos.map((todo) => (
            <div key={`${todo.status}:${todo.content}`} className="flex items-start gap-2 text-[12.5px]">
              {todo.status === "completed" ? (
                <CheckCircle2Icon className="mt-0.5 size-3.5 shrink-0 text-success" />
              ) : todo.status === "in_progress" ? (
                <CircleDashedIcon className="mt-0.5 size-3.5 shrink-0 text-primary" />
              ) : (
                <CircleIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
              )}
              <span
                className={cn(
                  "leading-5 text-foreground",
                  todo.status === "completed" && "text-muted-foreground line-through",
                )}
              >
                {todo.content}
              </span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
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
  const hasSources = props.citationSources && props.citationSources.length > 0;
  const hasInlineCitationChip =
    item.kind === "message" &&
    item.role === "assistant" &&
    extractCitationUrlsFromAnnotations(item.annotations).size > 0;

  if (item.kind === "message") {
    if (item.role === "user") {
      // action special rendering removed (feature fully stripped)
    }

    const userMessage = item.role === "user" ? parseUserMessageAttachments(item.text) : null;
    const canvasRequest = userMessage ? parseCanvasRequest(userMessage.cleanText) : null;
    const copyText =
      item.role === "user" && userMessage
        ? resolveUserCopyText({
            canvasRequest,
            cleanText: userMessage.cleanText,
            rawText: item.text,
          })
        : item.text;
    const isStreamingAssistant = item.role === "assistant" && props.isStreaming === true;

    return (
      <Message align={item.role === "user" ? "end" : "start"}>
        <MessageContent className="relative">
          {item.role === "assistant" ? (
            <Bubble variant="ghost" align="start">
              <BubbleContent>
                {isStreamingAssistant ? (
                  // Lightweight path while tokens stream: avoid full Streamdown reparse
                  // every delta. Swap to DesktopMarkdown once the item is complete.
                  <div
                    data-slot="streaming-markdown"
                    className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-[15px] leading-7 text-foreground"
                  >
                    {item.text}
                    <span
                      aria-hidden
                      data-slot="streaming-caret"
                      className="ml-0.5 inline-block h-[1.05em] w-[0.45em] translate-y-[0.1em] rounded-[1px] bg-foreground/70 align-baseline animate-pulse"
                    />
                  </div>
                ) : (
                  <DesktopMarkdown
                    citationAnnotations={item.annotations}
                    citationSources={props.citationSources}
                    citationUrlsByIndex={props.citationUrlsByIndex}
                    desktopBasePath={props.desktopBasePath}
                    normalizeDisplayCitations
                    fallbackToSourcesFooter={!hasSources}
                  >
                    {item.text}
                  </DesktopMarkdown>
                )}
              </BubbleContent>
            </Bubble>
          ) : (
            <Bubble
              variant="tinted"
              align="end"
              className="*:data-[slot=bubble-content]:border-primary/20 *:data-[slot=bubble-content]:bg-primary/[0.08] dark:*:data-[slot=bubble-content]:border-primary/25 dark:*:data-[slot=bubble-content]:bg-primary/[0.12]"
            >
              <BubbleContent className="cursor-text select-text rounded-2xl rounded-br-md px-3.5 py-2.5 shadow-[var(--shadow-surface-base)] whitespace-pre-wrap selection:bg-primary/20">
                <div className="flex flex-col gap-2">
                  {canvasRequest ? (
                    <CanvasRequestBody request={canvasRequest} catalog={mentionCatalog} />
                  ) : userMessage?.cleanText ? (
                    <MentionText text={userMessage.cleanText} catalog={mentionCatalog} />
                  ) : null}
                  {userMessage && userMessage.fileNames.length > 0 ? (
                    <UserAttachmentGroup fileNames={userMessage.fileNames} />
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

          <div
            className={cn(
              "pointer-events-none absolute top-1 z-10 flex items-center",
              item.role === "user" ? "left-1" : "right-1",
            )}
          >
            <div className="pointer-events-auto">
              <MessageCopyAction text={copyText} />
            </div>
          </div>
        </MessageContent>
      </Message>
    );
  }

  if (item.kind === "reasoning") {
    return null;
  }

  if (item.kind === "todos") {
    return <FeedTodosCard todos={item.todos} />;
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
        <MarkerContent className="flex flex-col gap-1 text-xs">
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
        <MarkerContent className="flex flex-col gap-1 text-xs">
          <span className="font-semibold uppercase tracking-wide text-primary">System</span>
          <span className="whitespace-pre-wrap">{item.line}</span>
        </MarkerContent>
      </Marker>
    );
  }

  return null;
});
