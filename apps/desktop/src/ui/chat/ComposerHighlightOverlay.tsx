import { forwardRef } from "react";

import { cn } from "@/lib/utils";
import { MENTION_CHIP_CLASS, type MentionCatalog, parseComposerSegments } from "./composerMentions";

/**
 * Read-only metric mirror rendered behind the composer textarea. It paints only
 * a semantic background for recognized mentions; the textarea paints every
 * glyph, its caret, and its selection. Decoration therefore cannot change text
 * advance or become the source of visible text.
 *
 * Resolved typography and client-box geometry are copied from the textarea by
 * the owner so delayed fonts, fallback fonts, scrollbars, and zoom stay aligned.
 */
export const ComposerHighlightOverlay = forwardRef<
  HTMLDivElement,
  { text: string; catalog: MentionCatalog; className?: string }
>(function ComposerHighlightOverlay({ text, catalog, className }, ref) {
  const segments = parseComposerSegments(text, catalog);
  return (
    <div
      ref={ref}
      aria-hidden
      data-slot="composer-highlight-overlay"
      className={cn(
        "pointer-events-none absolute left-0 top-0 select-none overflow-hidden whitespace-pre-wrap break-words px-1 py-1.5 text-[15px] leading-6 text-transparent",
        className,
      )}
    >
      {segments.map((segment) =>
        segment.type === "mention" ? (
          <span
            key={`mention-${segment.start}-${segment.name}`}
            data-mention-start={segment.start}
            data-mention-end={segment.end}
            className={cn(MENTION_CHIP_CLASS, "text-transparent")}
          >
            {segment.raw}
          </span>
        ) : (
          <span key={`text-${segment.start}`}>{segment.text}</span>
        ),
      )}
      {/* Trailing newline guard so a text ending in "\n" matches the textarea's extra line. */}
      {"\n"}
    </div>
  );
});
