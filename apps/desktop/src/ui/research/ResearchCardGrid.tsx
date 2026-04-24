import { ChevronRightIcon, CornerDownRightIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";

import { useAppStore } from "../../app/store";
import type { ResearchCard } from "../../app/types";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../../components/ui/collapsible";
import { Input } from "../../components/ui/input";
import { showContextMenu } from "../../lib/desktopCommands";
import { formatRelativeAge } from "../../lib/time";
import { cn } from "../../lib/utils";

function statusDotClassName(status: ResearchCard["status"]): string {
  switch (status) {
    case "completed":
      return "bg-success";
    case "running":
    case "pending":
      return "bg-primary";
    case "cancelled":
      return "bg-warning";
    case "failed":
      return "bg-destructive";
    default:
      return "bg-muted-foreground/60";
  }
}

function buildReportSnippet(markdown: string, title: string): string {
  if (!markdown) {
    return "";
  }

  const withoutFences = markdown.replace(/```[\s\S]*?```/g, " ");
  const paragraphs = withoutFences
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);
  const normalizedTitle = title.trim().toLowerCase();

  for (const block of paragraphs) {
    const headingMatch = block.match(/^#{1,6}\s+(.+)$/);
    if (headingMatch) {
      const headingText = headingMatch[1].trim().toLowerCase();
      if (headingText === normalizedTitle || normalizedTitle.includes(headingText) || headingText.includes(normalizedTitle)) {
        continue;
      }
    }
    const cleaned = cleanMarkdown(block);
    if (cleaned.length === 0) {
      continue;
    }
    return cleaned.length > 180 ? `${cleaned.slice(0, 177).trimEnd()}…` : cleaned;
  }

  return "";
}

function cleanMarkdown(block: string): string {
  return block
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/`{1,3}([^`]+)`{1,3}/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
    .replace(/【\d+†[^】]+】/g, "")
    .replace(/\[\^[^\]]+\]/g, "")
    .replace(/\[cite:\s*[\d\s,]+\s*\]/g, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

type CardProps = {
  research: ResearchCard;
  selected: boolean;
  depth: number;
  editing: boolean;
  editingTitle: string;
  onSelect: () => void;
  onStartEditing: () => void;
  onCancelEditing: () => void;
  onEditingTitleChange: (value: string) => void;
  onCommitRename: () => void;
  onContextMenu: (event: MouseEvent<HTMLElement>) => void;
};

function ResearchListCard({
  research,
  selected,
  depth,
  editing,
  editingTitle,
  onSelect,
  onStartEditing,
  onCancelEditing,
  onEditingTitleChange,
  onCommitRename,
  onContextMenu,
}: CardProps) {
  const running = research.status === "running" || research.status === "pending";
  const isChild = depth > 0;
  const timeLabel = formatRelativeAge(research.updatedAt);
  const displayTitle = research.title || research.prompt || "Untitled research";
  const snippet = useMemo(
    () => buildReportSnippet(research.outputsMarkdown, displayTitle),
    [displayTitle, research.outputsMarkdown],
  );
  const inputRef = useRef<HTMLInputElement | null>(null);
  const statusLabel = research.planPending ? "plan ready" : research.status;
  const sourceCount = research.sources.length;
  const thoughtCount = research.thoughtSummaries.length;

  useEffect(() => {
    if (!editing) {
      return;
    }
    const handle = window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
    return () => window.clearTimeout(handle);
  }, [editing]);

  if (editing) {
    return (
      <div
        className={cn(
          "flex w-full min-w-0 items-center gap-2 rounded-xl border border-border/60 bg-background/80 px-3 py-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]",
        )}
      >
        <Input
          ref={inputRef}
          className="min-w-0 h-7 flex-1 rounded-md border-border/70 text-[13px] shadow-none [&_[data-slot=input]]:h-7 [&_[data-slot=input]]:px-2 [&_[data-slot=input]]:text-[13px]"
          value={editingTitle}
          onChange={(event) => onEditingTitleChange(event.target.value)}
          onBlur={onCommitRename}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onCommitRename();
            } else if (event.key === "Escape") {
              event.preventDefault();
              onCancelEditing();
            }
          }}
        />
      </div>
    );
  }

  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      className={cn(
        "group relative flex w-full min-w-0 items-start gap-2 rounded-xl border px-3 py-2.5 text-left transition-[border-color,background-color,box-shadow,transform] duration-200",
        isChild && "before:absolute before:-left-3 before:top-1.5 before:bottom-1.5 before:w-px before:bg-border/55",
        selected
          ? "border-primary/45 bg-primary/[0.085] text-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]"
          : "border-border/45 bg-background/55 text-foreground/92 hover:border-border/70 hover:bg-background/80",
      )}
      onClick={onSelect}
      onContextMenu={onContextMenu}
      onDoubleClick={(event) => {
        event.preventDefault();
        onStartEditing();
      }}
    >
      {isChild ? (
        <CornerDownRightIcon
          className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground/60"
          aria-hidden="true"
        />
      ) : null}
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground/70">
          <span>{isChild ? "Follow-up" : "Research"}</span>
          <span
            className={cn(
              "inline-block h-1.5 w-1.5 rounded-full",
              research.planPending ? "bg-info" : statusDotClassName(research.status),
              running && "animate-pulse",
            )}
            aria-label={`Status: ${statusLabel}`}
          />
          <span className="truncate capitalize">{research.planPending ? "Plan ready" : research.status}</span>
        </div>
        <div className="line-clamp-2 text-[13px] font-medium leading-snug tracking-[-0.015em] text-foreground">
          {displayTitle}
        </div>
        {snippet ? (
          <div className="mt-1 line-clamp-2 text-[11.5px] leading-snug text-muted-foreground">
            {snippet}
          </div>
        ) : null}
        <div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-muted-foreground">
          {timeLabel ? <span>{timeLabel}</span> : null}
          {sourceCount > 0 ? <span>{sourceCount} source{sourceCount === 1 ? "" : "s"}</span> : null}
          {thoughtCount > 0 ? <span>{thoughtCount} note{thoughtCount === 1 ? "" : "s"}</span> : null}
        </div>
      </div>
    </button>
  );
}

type TreeProps = {
  parentId: string | null;
  childrenByParent: Map<string | null, ResearchCard[]>;
  selectedResearchId: string | null;
  editingId: string | null;
  editingTitle: string;
  onSelect: (researchId: string) => void;
  onStartEditing: (research: ResearchCard) => void;
  onCancelEditing: () => void;
  onEditingTitleChange: (value: string) => void;
  onCommitRename: () => void;
  onContextMenu: (event: MouseEvent<HTMLElement>, research: ResearchCard) => void;
  depth: number;
};

function renderResearchTree({
  parentId,
  childrenByParent,
  selectedResearchId,
  editingId,
  editingTitle,
  onSelect,
  onStartEditing,
  onCancelEditing,
  onEditingTitleChange,
  onCommitRename,
  onContextMenu,
  depth,
}: TreeProps) {
  return (childrenByParent.get(parentId) ?? []).map((research) => {
    const children = childrenByParent.get(research.id) ?? [];
    const descendantSelected = selectedResearchId === research.id
      || children.some((child) => child.id === selectedResearchId || child.parentResearchId === selectedResearchId);
    const isChild = depth > 0;

    return (
      <div key={research.id} className="space-y-1.5">
        <Collapsible className="space-y-1" defaultOpen={descendantSelected || depth < 1}>
          <div className={cn("flex items-start gap-1.5", isChild && "pl-3")}>
            {children.length > 0 ? (
              <CollapsibleTrigger asChild>
                <button
                  type="button"
                  className="group mt-2 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border border-transparent text-muted-foreground transition-colors hover:border-border/60 hover:bg-background/70 hover:text-foreground"
                  aria-label={descendantSelected ? "Collapse follow-ups" : "Expand follow-ups"}
                >
                  <ChevronRightIcon className="h-3.5 w-3.5 transition-transform group-data-[state=open]:rotate-90" />
                </button>
              </CollapsibleTrigger>
            ) : (
              <div className="mt-1.5 h-5 w-5 shrink-0" />
            )}
            <ResearchListCard
              research={research}
              selected={selectedResearchId === research.id}
              depth={depth}
              editing={editingId === research.id}
              editingTitle={editingTitle}
              onSelect={() => onSelect(research.id)}
              onStartEditing={() => onStartEditing(research)}
              onCancelEditing={onCancelEditing}
              onEditingTitleChange={onEditingTitleChange}
              onCommitRename={onCommitRename}
              onContextMenu={(event) => onContextMenu(event, research)}
            />
          </div>
          {children.length > 0 ? (
            <CollapsibleContent>
              <div className="ml-5 border-l border-border/35 pl-3 space-y-1.5">
                {renderResearchTree({
                  parentId: research.id,
                  childrenByParent,
                  selectedResearchId,
                  editingId,
                  editingTitle,
                  onSelect,
                  onStartEditing,
                  onCancelEditing,
                  onEditingTitleChange,
                  onCommitRename,
                  onContextMenu,
                  depth: depth + 1,
                })}
              </div>
            </CollapsibleContent>
          ) : null}
        </Collapsible>
      </div>
    );
  });
}

export function ResearchCardGrid({
  research,
  selectedResearchId,
  onSelectResearch,
}: {
  research: ResearchCard[];
  selectedResearchId: string | null;
  onSelectResearch: (researchId: string) => void;
}) {
  const renameResearch = useAppStore((s) => s.renameResearch);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");

  const childrenByParent = useMemo(() => {
    const map = new Map<string | null, ResearchCard[]>();
    for (const entry of research) {
      const key = entry.parentResearchId ?? null;
      const current = map.get(key) ?? [];
      current.push(entry);
      map.set(key, current);
    }
    for (const [key, entries] of map) {
      map.set(
        key,
        [...entries].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
      );
    }
    return map;
  }, [research]);

  const startEditing = useCallback((entry: ResearchCard) => {
    setEditingId(entry.id);
    setEditingTitle(entry.title || entry.prompt || "");
  }, []);

  const cancelEditing = useCallback(() => {
    setEditingId(null);
    setEditingTitle("");
  }, []);

  const commitRename = useCallback(() => {
    if (!editingId) {
      return;
    }
    const currentId = editingId;
    const trimmed = editingTitle.trim();
    setEditingId(null);
    setEditingTitle("");
    if (!trimmed) {
      return;
    }
    void renameResearch(currentId, trimmed);
  }, [editingId, editingTitle, renameResearch]);

  const handleContextMenu = useCallback(async (event: MouseEvent<HTMLElement>, entry: ResearchCard) => {
    event.preventDefault();
    event.stopPropagation();
    const result = await showContextMenu([
      { id: "open", label: "Open" },
      { id: "rename", label: "Rename" },
    ]);
    if (result === "open") {
      onSelectResearch(entry.id);
    } else if (result === "rename") {
      startEditing(entry);
    }
  }, [onSelectResearch, startEditing]);

  return (
    <div className="space-y-1.5" role="listbox" aria-label="Research history">
      {renderResearchTree({
        parentId: null,
        childrenByParent,
        selectedResearchId,
        editingId,
        editingTitle,
        onSelect: onSelectResearch,
        onStartEditing: startEditing,
        onCancelEditing: cancelEditing,
        onEditingTitleChange: setEditingTitle,
        onCommitRename: commitRename,
        onContextMenu: handleContextMenu,
        depth: 0,
      })}
    </div>
  );
}
