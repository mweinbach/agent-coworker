import {
  CheckIcon,
  CopyIcon,
  FileAudioIcon,
  FileIcon,
  FileImageIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  FileVideoIcon,
  MousePointerClickIcon,
  Table2Icon,
} from "lucide-react";
import { memo, useState } from "react";
import type { CitationSource } from "../../../../../src/shared/displayCitationMarkers";
import { extractCitationUrlsFromAnnotations } from "../../../../../src/shared/displayCitationMarkers";
import type { FeedItem } from "../../app/types";
import { Message, MessageContent } from "../../components/ai-elements/message";
import { SourcesCarousel } from "../../components/ai-elements/sources-carousel";
import { Card, CardContent } from "../../components/ui/card";
import { openExternalSource } from "../../lib/openExternalSource";
import { cn } from "../../lib/utils";
import { DesktopMarkdown } from "../markdown";
import { A2uiInlineCard } from "./a2ui/A2uiInlineCard";
import { A2uiSurfaceHistoryRow } from "./a2ui/A2uiSurfaceHistoryRow";
import { useChatViewContext } from "./ChatViewContext";
import { parseA2uiActionMessage, summarizeA2uiActionMessage } from "./chatLogic";
import type { MentionCatalog } from "./composerMentions";
import {
  type CanvasRequest,
  parseCanvasRequest,
  parseUserMessageAttachments,
} from "./feedMessageParsing";
import { MentionText } from "./MentionText";
import { ToolCard } from "./toolCards/ToolCard";

function MessageCopyAction(props: { text: string; align: "start" | "end" }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(props.text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard may be unavailable (permissions, non-secure context). Fail silently.
    }
  };
  return (
    <div className={props.align === "end" ? "flex justify-end" : "flex justify-start"}>
      <button
        type="button"
        onClick={handleCopy}
        aria-label={copied ? "Copied" : "Copy message"}
        className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground opacity-0 transition-opacity duration-150 hover:bg-muted/60 hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 group-hover:opacity-100 group-focus-within:opacity-100"
      >
        {copied ? <CheckIcon className="size-3 text-success" /> : <CopyIcon className="size-3" />}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

function ErrorFeedRow(props: { message: string }) {
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(props.message);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable — fail silently.
    }
  };
  return (
    <Card className="w-full min-w-0 max-w-3xl overflow-hidden border-destructive/40 bg-destructive/10">
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

export const FeedRow = memo(function FeedRow(props: {
  item: FeedItem;
  citationUrlsByIndex?: ReadonlyMap<number, string>;
  citationSources?: CitationSource[];
  desktopBasePath?: string | null;
  isLatestUiSurface?: boolean;
  a2uiEnabled: boolean;
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
      const a2uiAction = parseA2uiActionMessage(item.text);
      if (a2uiAction) {
        if (!props.a2uiEnabled) {
          return null;
        }
        return (
          <div className="flex w-full justify-end">
            <div
              role="status"
              className="inline-flex max-w-[32rem] items-center gap-2 rounded-full border border-border/45 bg-muted/25 py-1 pl-2.5 pr-3 text-xs text-foreground shadow-sm"
              title={`Surface ${a2uiAction.surfaceId} • Event ${a2uiAction.eventType}`}
            >
              <span className="flex size-4 items-center justify-center rounded-full bg-primary/15 text-primary">
                <MousePointerClickIcon className="size-2.5" />
              </span>
              <span className="truncate font-medium text-foreground/90">
                {summarizeA2uiActionMessage(a2uiAction)}
              </span>
              <span className="truncate font-mono text-[10px] text-muted-foreground">
                {a2uiAction.surfaceId}
              </span>
            </div>
          </div>
        );
      }
    }

    return (
      <Message from={item.role}>
        <MessageContent>
          {item.role === "assistant" ? (
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
          ) : (
            <div className="whitespace-pre-wrap">
              {(() => {
                const { cleanText, fileNames } = parseUserMessageAttachments(item.text);
                const canvasRequest = parseCanvasRequest(cleanText);

                return (
                  <div className="flex flex-col gap-3">
                    {cleanText ? (
                      <div>
                        {canvasRequest ? (
                          <CanvasRequestBody request={canvasRequest} catalog={mentionCatalog} />
                        ) : (
                          <MentionText text={cleanText} catalog={mentionCatalog} />
                        )}
                      </div>
                    ) : null}
                    {fileNames.length > 0 && (
                      <div className="flex min-w-0 flex-wrap gap-2 mt-1">
                        {fileNames.map((fileName) => {
                          const isAudio = /\.(mp3|wav|ogg|m4a|aac|flac)$/i.test(fileName);
                          const isImage = /\.(png|jpe?g|gif|webp|svg)$/i.test(fileName);
                          const isPdf = /\.pdf$/i.test(fileName);
                          const isVideo = /\.(mp4|mov|avi|mkv|webm)$/i.test(fileName);

                          let IconComponent = FileIcon;
                          if (isAudio) IconComponent = FileAudioIcon;
                          else if (isImage) IconComponent = FileImageIcon;
                          else if (isVideo) IconComponent = FileVideoIcon;
                          else if (isPdf) IconComponent = FileTextIcon;

                          return (
                            <div
                              key={fileName}
                              className="inline-flex min-w-0 max-w-full items-center gap-2 overflow-hidden rounded-lg border border-border/40 bg-muted/40 px-2.5 py-1.5 text-xs shadow-sm"
                            >
                              <IconComponent className="size-4 text-muted-foreground shrink-0" />
                              <span
                                className="min-w-0 truncate font-medium text-foreground"
                                title={fileName}
                              >
                                {fileName}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
          )}
        </MessageContent>
        <MessageCopyAction text={item.text} align={item.role === "user" ? "end" : "start"} />
        {hasSources && !hasInlineCitationChip && props.citationSources ? (
          <SourcesCarousel
            sources={props.citationSources}
            onOpenSource={openExternalSource}
            className="mt-1"
          />
        ) : null}
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

  if (item.kind === "ui_surface") {
    if (!props.a2uiEnabled) {
      return null;
    }
    return props.isLatestUiSurface ? (
      <A2uiInlineCard item={item} />
    ) : (
      <A2uiSurfaceHistoryRow item={item} />
    );
  }

  if (item.kind === "log") {
    if (!developerMode) return null;
    return (
      <Card className="max-w-3xl border-border/70 bg-muted/30">
        <CardContent className="select-text p-3 text-xs text-muted-foreground">
          <div className="mb-1 font-semibold uppercase tracking-wide text-primary">Log</div>
          <div className="whitespace-pre-wrap">{item.line}</div>
        </CardContent>
      </Card>
    );
  }

  if (item.kind === "error") {
    return <ErrorFeedRow message={item.message} />;
  }

  if (item.kind === "system") {
    return (
      <Card className="max-w-3xl border-border/70 bg-muted/30">
        <CardContent className="select-text p-3 text-xs text-muted-foreground">
          <div className="mb-1 font-semibold uppercase tracking-wide text-primary">System</div>
          <div className="whitespace-pre-wrap">{item.line}</div>
        </CardContent>
      </Card>
    );
  }

  return null;
});
