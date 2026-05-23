import {
  FileAudioIcon,
  FileIcon,
  FileImageIcon,
  FileTextIcon,
  FileVideoIcon,
  MousePointerClickIcon,
} from "lucide-react";
import { memo } from "react";
import type { CitationSource } from "../../../../../src/shared/displayCitationMarkers";
import { extractCitationUrlsFromAnnotations } from "../../../../../src/shared/displayCitationMarkers";
import type { FeedItem } from "../../app/types";
import { Message, MessageContent, MessageResponse } from "../../components/ai-elements/message";
import { SourcesCarousel } from "../../components/ai-elements/sources-carousel";
import { Card, CardContent } from "../../components/ui/card";
import { A2uiInlineCard } from "./a2ui/A2uiInlineCard";
import { A2uiSurfaceHistoryRow } from "./a2ui/A2uiSurfaceHistoryRow";
import { useChatViewContext } from "./ChatViewContext";
import { parseA2uiActionMessage, summarizeA2uiActionMessage } from "./chatLogic";
import { parseCanvasEditMessage, parseUserMessageAttachments } from "./feedMessageParsing";
import { ToolCard } from "./toolCards/ToolCard";

export const FeedRow = memo(function FeedRow(props: {
  item: FeedItem;
  citationUrlsByIndex?: ReadonlyMap<number, string>;
  citationSources?: CitationSource[];
  desktopBasePath?: string | null;
  isLatestUiSurface?: boolean;
  a2uiEnabled: boolean;
}) {
  const { developerMode } = useChatViewContext();
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
            <MessageResponse
              citationAnnotations={item.annotations}
              citationSources={props.citationSources}
              citationUrlsByIndex={props.citationUrlsByIndex}
              desktopBasePath={props.desktopBasePath}
              normalizeDisplayCitations
              fallbackToSourcesFooter={!hasSources}
            >
              {item.text}
            </MessageResponse>
          ) : (
            <div className="whitespace-pre-wrap">
              {(() => {
                const { cleanText, fileNames } = parseUserMessageAttachments(item.text);
                const parsed = parseCanvasEditMessage(cleanText);

                return (
                  <div className="flex flex-col gap-3">
                    {cleanText ? (
                      <div>
                        {parsed ? (
                          <div className="flex flex-col gap-1.5">
                            {parsed.selection && (
                              <div className="text-[10px] font-semibold text-primary/70 uppercase tracking-wider flex items-center gap-1 select-none">
                                <span>Selected Text</span>
                              </div>
                            )}
                            <div>{parsed.instructions}</div>
                          </div>
                        ) : (
                          cleanText
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
        {hasSources && !hasInlineCitationChip && props.citationSources ? (
          <SourcesCarousel sources={props.citationSources} className="mt-1" />
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
    return (
      <Card className="w-full min-w-0 max-w-3xl overflow-hidden border-destructive/40 bg-destructive/10">
        <CardContent className="select-text p-3 text-sm">
          <div className="mb-1 font-semibold uppercase tracking-wide text-destructive">Error</div>
          <div className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
            {item.message}
          </div>
        </CardContent>
      </Card>
    );
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
