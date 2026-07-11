import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { type ComposerCaretAnchor, placeComposerMentionMenu } from "./composerMentionGeometry";
import type { MentionItem } from "./composerMentions";

/**
 * Autocomplete panel for @-mentions. It is driven externally (the textarea keeps
 * focus and owns keyboard navigation), so primary pointer-down selects before a
 * browser blur can clear the active token. The portalled listbox is fixed to the
 * caret and flips/clamps against the viewport.
 */
export function ComposerMentionMenu(props: {
  anchor: ComposerCaretAnchor;
  id: string;
  optionId: (item: MentionItem) => string;
  items: MentionItem[];
  activeIndex: number;
  query?: string;
  onSelect: (item: MentionItem) => void;
  onHover: (index: number) => void;
  zIndex?: number;
}) {
  const { anchor, id, optionId, items, activeIndex, query, onSelect, onHover, zIndex } = props;
  const menuRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Array<HTMLDivElement | null>>([]);
  const [menuSize, setMenuSize] = useState({ height: 272, width: 384 });
  const [viewport, setViewport] = useState(() => ({
    devicePixelRatio: window.devicePixelRatio,
    height: window.innerHeight,
    width: window.innerWidth,
  }));

  // Keep the keyboard-active option visible inside the scrollable list.
  useEffect(() => {
    const el = itemRefs.current[activeIndex];
    if (el) el.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const updateSize = () => {
      const rect = menu.getBoundingClientRect();
      setMenuSize((current) =>
        current.height === rect.height && current.width === rect.width
          ? current
          : { height: rect.height, width: rect.width },
      );
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(menu);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const updateViewport = () => {
      setViewport({
        devicePixelRatio: window.devicePixelRatio,
        height: window.innerHeight,
        width: window.innerWidth,
      });
    };
    window.addEventListener("resize", updateViewport);
    window.visualViewport?.addEventListener("resize", updateViewport);
    return () => {
      window.removeEventListener("resize", updateViewport);
      window.visualViewport?.removeEventListener("resize", updateViewport);
    };
  }, []);

  const position = placeComposerMentionMenu({
    anchor,
    devicePixelRatio: viewport.devicePixelRatio,
    menuHeight: menuSize.height,
    menuWidth: menuSize.width,
    viewportHeight: viewport.height,
    viewportWidth: viewport.width,
  });
  const menuStyle = {
    left: position.left,
    maxHeight: position.maxHeight,
    top: position.top,
    zIndex,
  };
  const menuClassName =
    "fixed z-50 flex w-[24rem] max-w-[calc(100vw-1rem)] flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-md";

  if (items.length === 0) {
    const trimmed = (query ?? "").trim();
    return createPortal(
      <div
        ref={menuRef}
        id={id}
        data-slot="composer-mention-menu"
        data-placement={position.placement}
        role="listbox"
        aria-label="Mentions"
        aria-busy="false"
        className={menuClassName}
        style={menuStyle}
      >
        <div className="p-2 text-xs text-muted-foreground">
          {trimmed ? `No skills or plugins match “${trimmed}”.` : "No skills or plugins available."}
        </div>
      </div>,
      document.body,
    );
  }

  const groups = (["skill", "plugin"] as const)
    .map((kind) => ({
      items: items
        .map((item, index) => ({ index, item }))
        .filter((entry) => entry.item.kind === kind),
      kind,
    }))
    .filter((group) => group.items.length > 0);

  return createPortal(
    <div
      ref={menuRef}
      id={id}
      data-slot="composer-mention-menu"
      data-placement={position.placement}
      role="listbox"
      aria-label="Mentions"
      className={menuClassName}
      style={menuStyle}
    >
      <div className="min-h-0 overflow-y-auto p-1">
        {groups.map((group) => {
          const headingId = `${id}-${group.kind}-heading`;
          return (
            <fieldset
              key={group.kind}
              aria-labelledby={headingId}
              className="m-0 min-w-0 border-0 p-0"
            >
              <div
                id={headingId}
                role="presentation"
                className="px-2 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
              >
                {group.kind === "skill" ? "Skills" : "Plugins"}
              </div>
              {group.items.map(({ index, item }) => {
                const active = index === activeIndex;
                return (
                  <div
                    key={`${item.kind}:${item.name}`}
                    id={optionId(item)}
                    ref={(element) => {
                      itemRefs.current[index] = element;
                    }}
                    role="option"
                    tabIndex={-1}
                    aria-posinset={index + 1}
                    aria-selected={active}
                    aria-setsize={items.length}
                    onPointerDown={(event) => {
                      if (event.button !== 0) return;
                      event.preventDefault();
                      onSelect(item);
                    }}
                    onPointerEnter={() => onHover(index)}
                    className={cn(
                      "flex w-full cursor-default items-center gap-2 rounded-lg px-2 py-1.5 text-left",
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
                  </div>
                );
              })}
            </fieldset>
          );
        })}
      </div>
    </div>,
    document.body,
  );
}
