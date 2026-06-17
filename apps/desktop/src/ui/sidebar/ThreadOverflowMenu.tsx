import { ArchiveIcon, BrainCircuitIcon, HistoryIcon, MoreHorizontalIcon, PencilIcon } from "lucide-react";
import { type MouseEvent } from "react";
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
  const stop = (event: MouseEvent) => {
    event.stopPropagation();
    event.preventDefault();
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
          onPointerDown={stop}
          onClick={stop}
          className={cn(
            "size-5 shrink-0 rounded-md text-muted-foreground/60 hover:text-foreground/85 hover:bg-foreground/[0.06]",
            triggerVisibilityClassName,
            className,
          )}
        >
          <MoreHorizontalIcon className="h-3.5 w-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={stop}>
        <DropdownMenuItem onSelect={onRename}>
          <PencilIcon />
          Rename
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onArchive}>
          <ArchiveIcon />
          Archive
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onGenerateMemory} disabled={!canGenerateMemory}>
          <BrainCircuitIcon />
          Generate memory from conversation
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onDeleteHistory} variant="destructive">
          <HistoryIcon />
          Delete session history
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
