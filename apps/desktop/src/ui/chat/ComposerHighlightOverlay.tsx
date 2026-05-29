import { forwardRef } from "react";

import { cn } from "@/lib/utils";
import { type MentionCatalog, MENTION_CHIP_CLASS, parseComposerSegments } from "./composerMentions";

/**
 * Read-only mirror rendered behind the composer textarea. It re-renders the
 * composer text with @-mention tokens wrapped in an outlined box. The textarea
 * on top has transparent text and a visible caret, so the user sees this layer's
 * text (plain text in the normal color, mentions accent-colored and boxed) while
 * typing/selecting natively.
 *
 * Typography, padding, and wrapping MUST stay identical to `PromptInputTextarea`
 * so glyph positions (and therefore the caret) line up. Scroll is synced by the
 * owner via this element's ref.
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
        "pointer-events-none absolute inset-0 select-none overflow-hidden whitespace-pre-wrap break-words px-1 py-1.5 text-[15px] leading-6 text-foreground",
        className,
      )}
    >
      {segments.map((segment) =>
        segment.type === "mention" ? (
          <span
            key={`mention-${segment.start}-${segment.name}`}
            className={cn(MENTION_CHIP_CLASS, "-mx-0.5 px-0.5")}
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
