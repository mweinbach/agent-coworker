import { useEffect, useRef } from "react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { MentionItem } from "./composerMentions";

/**
 * Autocomplete panel for @-mentions. It is driven externally (the textarea keeps
 * focus and owns keyboard navigation), so selection uses `onMouseDown` +
 * `preventDefault` to avoid stealing focus from the textarea. Anchored above the
 * composer input.
 */
export function ComposerMentionMenu(props: {
  items: MentionItem[];
  activeIndex: number;
  query?: string;
  onSelect: (item: MentionItem) => void;
  onHover: (index: number) => void;
}) {
  const { items, activeIndex, query, onSelect, onHover } = props;
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // Keep the keyboard-active option visible inside the scrollable list.
  useEffect(() => {
    const el = itemRefs.current[activeIndex];
    if (el) el.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  if (items.length === 0) {
    const trimmed = (query ?? "").trim();
    return (
      <div
        data-slot="composer-mention-menu"
        role="listbox"
        aria-busy="false"
        className="absolute bottom-full left-0 z-50 mb-2 w-[24rem] max-w-[92vw] overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-md"
      >
        <div className="p-2 text-xs text-muted-foreground">
          {trimmed ? `No skills or plugins match “${trimmed}”.` : "No skills or plugins available."}
        </div>
      </div>
    );
  }

  let lastKind: MentionItem["kind"] | null = null;

  return (
    <div
      data-slot="composer-mention-menu"
      role="listbox"
      className="absolute bottom-full left-0 z-50 mb-2 w-[24rem] max-w-[92vw] overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-md"
    >
      <div className="max-h-64 overflow-y-auto p-1">
        {items.map((item, index) => {
          const showHeader = item.kind !== lastKind;
          lastKind = item.kind;
          const active = index === activeIndex;
          return (
            <div key={`${item.kind}:${item.name}`}>
              {showHeader ? (
                <div className="px-2 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  {item.kind === "skill" ? "Skills" : "Plugins"}
                </div>
              ) : null}
              <button
                ref={(el) => {
                  itemRefs.current[index] = el;
                }}
                type="button"
                role="option"
                aria-selected={active}
                // Keep textarea focus: prevent the mousedown from blurring it.
                onMouseDown={(event) => {
                  event.preventDefault();
                  onSelect(item);
                }}
                onMouseEnter={() => onHover(index)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left",
                  active ? "bg-accent text-accent-foreground" : "text-foreground",
                )}
              >
                <div className="flex min-w-0 flex-col">
                  <span className="truncate text-sm font-medium">@{item.name}</span>
                  {item.description ? (
                    <span
                      className={cn(
                        "truncate text-xs",
                        active ? "text-accent-foreground/80" : "text-muted-foreground",
                      )}
                    >
                      {item.description}
                    </span>
                  ) : null}
                </div>
                <Badge variant="secondary" className="ml-auto shrink-0 text-[10px]">
                  {item.badge}
                </Badge>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
