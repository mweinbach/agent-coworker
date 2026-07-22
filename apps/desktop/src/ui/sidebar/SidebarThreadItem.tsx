import { type MouseEvent, memo, type RefObject } from "react";
import { composerDraftKeyForThread, hasComposerDraftContent } from "../../app/composerDrafts";
import { countOutstandingInteractions } from "../../app/interactionQueue";
import { useAppStore } from "../../app/store";
import type { ThreadRecord } from "../../app/types";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { isEnterWithoutIme } from "../../lib/keyboard";
import { cn } from "../../lib/utils";
import { recordDesktopRenderMetric } from "../renderDiagnostics";
import { formatSidebarRelativeAge } from "../sidebarHelpers";
import { ThreadOverflowMenu } from "./ThreadOverflowMenu";

export type SidebarThreadItemProps = {
  editInputRef: RefObject<HTMLInputElement | null>;
  editingThreadId: string | null;
  editingTitle: string;
  onArchiveThread: (threadId: string, title: string) => void;
  onCancelRename: () => void;
  onCommitRename: (threadId: string, title: string) => void;
  onDeleteHistoryForThread: (threadId: string, title: string) => void;
  onEditingTitleChange: (title: string) => void;
  onGenerateMemoryForThread: (threadId: string) => void;
  onStartEditing: (threadId: string, currentTitle: string) => void;
  onThreadContextMenu: (event: MouseEvent<HTMLElement>, threadId: string, title: string) => void;
  selectedThreadId: string | null;
  selectThread: (threadId: string) => void;
  thread: ThreadRecord;
  canGenerateMemory: boolean;
};

function overflowTriggerVisibilityClassName(isActive: boolean): string {
  return isActive
    ? "opacity-100 pointer-events-auto scale-100"
    : "opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto transform scale-75 group-hover:scale-100 group-focus-within:scale-100";
}

export const SidebarThreadItem = memo(function SidebarThreadItem({
  editInputRef,
  editingThreadId,
  editingTitle,
  onArchiveThread,
  onCancelRename,
  onCommitRename,
  onDeleteHistoryForThread,
  onEditingTitleChange,
  onGenerateMemoryForThread,
  onStartEditing,
  onThreadContextMenu,
  selectedThreadId,
  selectThread,
  thread,
  canGenerateMemory,
}: SidebarThreadItemProps) {
  const busy = useAppStore((state) => state.threadRuntimeById[thread.id]?.busy === true);
  recordDesktopRenderMetric("sidebar-thread-row", thread.id);
  const isActive = thread.id === selectedThreadId;
  const isEditing = editingThreadId === thread.id;
  const displayTitle = thread.title || "New chat";
  const ageLabel = formatSidebarRelativeAge(thread.lastMessageAt);
  const hasDraft = useAppStore((state) =>
    hasComposerDraftContent(state.composerDraftsByKey[composerDraftKeyForThread(thread.id)]),
  );
  const interactionCount = useAppStore((state) =>
    countOutstandingInteractions(state.interactionsByThread[thread.id]),
  );

  if (isEditing) {
    return (
      <div className="sidebar-thread-item flex w-full items-center gap-2.5 rounded-lg border border-border/40 bg-foreground/[0.04] px-2.5 py-1.5 text-left text-foreground">
        <Input
          ref={editInputRef}
          className="min-w-0 w-full h-7 rounded-md border-border/70 text-[13px] shadow-none [&_[data-slot=input]]:h-7 [&_[data-slot=input]]:px-2 [&_[data-slot=input]]:text-[13px]"
          value={editingTitle}
          onBlur={() => onCommitRename(thread.id, editingTitle)}
          onChange={(event) => onEditingTitleChange(event.target.value)}
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (isEnterWithoutIme(event)) {
              event.preventDefault();
              onCommitRename(thread.id, editingTitle);
            } else if (event.key === "Escape") {
              event.preventDefault();
              onCancelRename();
            }
          }}
        />
      </div>
    );
  }

  return (
    <div className="relative group min-w-0">
      <Button
        className={cn(
          "sidebar-thread-item sidebar-lift flex min-w-0 w-full items-center gap-2.5 rounded-lg border border-transparent px-2.5 py-1.5 text-left",
          isActive
            ? "border-border/45 bg-foreground/[0.05] text-foreground"
            : "text-foreground/82 hover:border-border/35 hover:bg-foreground/[0.035] hover:text-foreground",
        )}
        onClick={() => selectThread(thread.id)}
        onContextMenu={(event) => onThreadContextMenu(event, thread.id, displayTitle)}
        onDoubleClick={() => onStartEditing(thread.id, displayTitle)}
        title={displayTitle}
        type="button"
        variant="ghost"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium tracking-[-0.018em]">
            {displayTitle}
          </span>
        </span>

        <span className="relative flex shrink-0 items-center gap-2 pl-2 min-w-8 justify-end">
          {interactionCount > 0 ? (
            <Badge
              variant="secondary"
              className="h-5 min-w-5 justify-center px-1.5 text-xs"
              aria-label={`${interactionCount} pending ${interactionCount === 1 ? "interaction" : "interactions"}`}
            >
              {interactionCount}
            </Badge>
          ) : busy ? (
            <span
              className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse"
              aria-hidden="true"
            />
          ) : hasDraft ? (
            <span
              className="size-1.5 rounded-full bg-muted-foreground/70"
              role="status"
              aria-label="Unsent draft"
              title="Unsent draft"
            />
          ) : ageLabel ? (
            <span
              className={cn(
                "text-xs font-medium text-muted-foreground transition-opacity duration-150 group-hover:opacity-0 group-hover:pointer-events-none group-focus-within:opacity-0 group-focus-within:pointer-events-none",
                isActive && "opacity-0 pointer-events-none",
              )}
            >
              {ageLabel}
            </span>
          ) : null}
        </span>
      </Button>
      <div className="absolute right-1.5 top-1/2 z-10 flex -translate-y-1/2 items-center gap-0.5 pointer-events-none">
        <ThreadOverflowMenu
          canGenerateMemory={canGenerateMemory}
          ariaLabelSuffix={displayTitle}
          triggerVisibilityClassName={overflowTriggerVisibilityClassName(isActive)}
          onRename={() => onStartEditing(thread.id, displayTitle)}
          onArchive={() => onArchiveThread(thread.id, displayTitle)}
          onGenerateMemory={() => onGenerateMemoryForThread(thread.id)}
          onDeleteHistory={() => onDeleteHistoryForThread(thread.id, displayTitle)}
        />
      </div>
    </div>
  );
});
