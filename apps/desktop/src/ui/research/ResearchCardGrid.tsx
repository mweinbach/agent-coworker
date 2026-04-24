import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";

import { useAppStore } from "../../app/store";
import type { ResearchCard } from "../../app/types";
import { Input } from "../../components/ui/input";
import { showContextMenu } from "../../lib/desktopCommands";
import { formatRelativeAge } from "../../lib/time";
import { cn } from "../../lib/utils";

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

function statusDotClassName(status: ResearchCard["status"]): string {
  switch (status) {
    case "running":
    case "pending":
      return "bg-primary";
    case "failed":
      return "bg-destructive";
    case "cancelled":
      return "bg-warning";
    default:
      return "";
  }
}

type ItemProps = {
  research: ResearchCard;
  selected: boolean;
  isChild: boolean;
  editing: boolean;
  editingTitle: string;
  onSelect: () => void;
  onStartEditing: () => void;
  onCancelEditing: () => void;
  onEditingTitleChange: (value: string) => void;
  onCommitRename: () => void;
  onContextMenu: (event: MouseEvent<HTMLElement>) => void;
};

function ResearchListItem({
  research,
  selected,
  isChild,
  editing,
  editingTitle,
  onSelect,
  onStartEditing,
  onCancelEditing,
  onEditingTitleChange,
  onCommitRename,
  onContextMenu,
}: ItemProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const running = research.status === "running" || research.status === "pending";
  const timeLabel = formatRelativeAge(research.updatedAt);
  const displayTitle = research.title || research.prompt || "Untitled research";
  const dotClass = research.planPending ? "bg-info" : statusDotClassName(research.status);
  const snippet = useMemo(
    () => buildReportSnippet(research.outputsMarkdown, displayTitle),
    [displayTitle, research.outputsMarkdown],
  );

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
      <div className="sidebar-thread-item flex w-full items-center gap-2.5 rounded-lg border border-border/40 bg-foreground/[0.04] px-2.5 py-1.5 text-left text-foreground">
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
        "sidebar-thread-item sidebar-lift flex w-full items-start gap-2.5 rounded-lg border border-transparent px-2.5 py-2 text-left",
        selected
          ? "border-border/45 bg-foreground/[0.05] text-foreground"
          : "text-foreground/82 hover:border-border/35 hover:bg-foreground/[0.035] hover:text-foreground",
      )}
      onClick={onSelect}
      onContextMenu={onContextMenu}
      onDoubleClick={(event) => {
        event.preventDefault();
        onStartEditing();
      }}
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium tracking-[-0.018em]">
          {isChild ? (
            <span className="mr-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70">
              Follow-up
            </span>
          ) : null}
          {displayTitle}
        </span>
        {snippet ? (
          <span className="mt-0.5 block line-clamp-2 text-[11.5px] leading-snug text-muted-foreground">
            {snippet}
          </span>
        ) : null}
      </span>

      <span className="mt-0.5 flex shrink-0 items-center gap-2 pl-2">
        {dotClass ? (
          <span
            className={cn("h-1.5 w-1.5 rounded-full", dotClass, running && "animate-pulse")}
            aria-hidden="true"
          />
        ) : null}
        {timeLabel ? (
          <span className="text-[11px] font-medium text-muted-foreground">{timeLabel}</span>
        ) : null}
      </span>
    </button>
  );
}

type TreeProps = {
  parentId: string | null;
  depth: number;
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
};

function renderResearchTree({
  parentId,
  depth,
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
}: TreeProps) {
  const entries = childrenByParent.get(parentId) ?? [];
  if (entries.length === 0) {
    return null;
  }

  return entries.map((research) => {
    const children = childrenByParent.get(research.id) ?? [];

    return (
      <div key={research.id} className="flex flex-col gap-1">
        <ResearchListItem
          research={research}
          selected={selectedResearchId === research.id}
          isChild={depth > 0}
          editing={editingId === research.id}
          editingTitle={editingTitle}
          onSelect={() => onSelect(research.id)}
          onStartEditing={() => onStartEditing(research)}
          onCancelEditing={onCancelEditing}
          onEditingTitleChange={onEditingTitleChange}
          onCommitRename={onCommitRename}
          onContextMenu={(event) => onContextMenu(event, research)}
        />
        {children.length > 0 ? (
          <div className="ml-3 space-y-1 border-l border-border/45 pl-3">
            {renderResearchTree({
              parentId: research.id,
              depth: depth + 1,
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
            })}
          </div>
        ) : null}
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
    <div role="listbox" aria-label="Research history" className="flex flex-col gap-1">
      {renderResearchTree({
        parentId: null,
        depth: 0,
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
      })}
    </div>
  );
}
