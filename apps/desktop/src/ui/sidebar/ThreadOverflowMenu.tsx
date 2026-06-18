import {
  ArchiveIcon,
  BrainCircuitIcon,
  HistoryIcon,
  MoreHorizontalIcon,
  PencilIcon,
} from "lucide-react";
import type { MouseEvent } from "react";
import { Button } from "../../components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu";
import { cn } from "../../lib/utils";

export type ThreadOverflowMenuProps = {
  /** Whether the "Generate memory" action is available for this thread. */
  canGenerateMemory: boolean;
  /** Start inline rename for this thread. */
  onRename: () => void;
  /** Archive this thread. */
  onArchive: () => void;
  /** Generate an advanced memory from this thread's transcript. */
  onGenerateMemory: () => void;
  /** Delete the server-side + local transcript history for this thread. */
  onDeleteHistory: () => void;
  /** Aria label suffix describing which thread the menu controls. */
  ariaLabelSuffix: string;
  /**
   * Tailwind classes controlling the trigger's visibility. The parent owns
   * this so the trigger participates in its `group` hover/focus-within reveal
   * (matching the existing archive button) instead of being pinned visible.
   */
  triggerVisibilityClassName?: string;
  className?: string;
};

/**
 * Keyboard/touch-accessible overflow menu for a single sidebar thread row.
 *
 * Mirrors the actions exposed by the right-click context menu (Rename,
 * Generate memory, Delete history) plus Archive, which previously only existed
 * as a hover-only affordance. Rendered as a Radix DropdownMenu so it is fully
 * keyboard navigable and works on touch devices.
 */
export function ThreadOverflowMenu({
  canGenerateMemory,
  onRename,
  onArchive,
  onGenerateMemory,
  onDeleteHistory,
  ariaLabelSuffix,
  triggerVisibilityClassName,
  className,
}: ThreadOverflowMenuProps) {
  // Stop the click/pointer from bubbling up to the thread row (which would
  // select it), but do NOT call preventDefault(): Radix composes its own open
  // handler after ours and bails when `event.defaultPrevented` is true, which
  // previously prevented the menu from ever opening.
  const stopPropagationOnly = (event: MouseEvent) => {
    event.stopPropagation();
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          aria-label={`More actions for ${ariaLabelSuffix}`}
          size="icon-sm"
          variant="ghost"
          data-thread-overflow-trigger="true"
          onPointerDown={stopPropagationOnly}
          onClick={stopPropagationOnly}
          className={cn(
            "size-5 shrink-0 rounded-md text-muted-foreground/60 hover:text-foreground/85 hover:bg-foreground/[0.06] data-[state=open]:pointer-events-auto data-[state=open]:opacity-100 data-[state=open]:scale-100",
            triggerVisibilityClassName,
            className,
          )}
        >
          <MoreHorizontalIcon className="h-3.5 w-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        onClick={stopPropagationOnly}
        className="min-w-[12.5rem] rounded-lg border-border/50 bg-popover/95 p-1 text-popover-foreground app-shadow-popover ring-1 ring-black/[0.04] backdrop-blur-md"
      >
        <DropdownMenuItem onSelect={onRename} className="gap-2.5 rounded-md">
          <PencilIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0">Rename</span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onArchive} className="gap-2.5 rounded-md">
          <ArchiveIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0">Archive</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={onGenerateMemory}
          disabled={!canGenerateMemory}
          className="gap-2.5 rounded-md"
        >
          <BrainCircuitIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate">Generate memory from conversation</span>
        </DropdownMenuItem>
        <hr className="my-1 h-px border-0 bg-border/45" />
        <DropdownMenuItem
          onSelect={onDeleteHistory}
          variant="destructive"
          className="gap-2.5 rounded-md"
        >
          <HistoryIcon className="size-4 shrink-0" />
          <span className="min-w-0">Delete session history</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
