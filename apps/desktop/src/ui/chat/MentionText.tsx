import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  type MentionCatalog,
  type MentionItem,
  type MentionKind,
  MENTION_CHIP_CLASS,
  parseComposerSegments,
} from "./composerMentions";

function MentionChip(props: {
  kind: MentionKind;
  name: string;
  item: MentionItem | undefined;
}) {
  const { kind, name, item } = props;
  const label = `@${name}`;

  // Unknown / stale reference (no longer in the catalog): styled, but not clickable.
  if (!item) {
    return <span className={cn(MENTION_CHIP_CLASS, "inline px-1 py-0.5 opacity-80")}>{label}</span>;
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            MENTION_CHIP_CLASS,
            "inline cursor-pointer px-1 py-0.5 align-baseline transition-colors hover:bg-primary/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
          )}
          title={`View ${kind} "${name}"`}
        >
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-3">
        <div className="mb-1.5 flex items-center gap-2">
          <span className="min-w-0 truncate text-sm font-semibold text-foreground">
            {item.label}
          </span>
          <Badge variant="secondary" className="ml-auto shrink-0 text-[10px]">
            {kind === "skill" ? "Skill" : "Plugin"}
          </Badge>
        </div>
        {item.badge ? (
          <div className="mb-1.5 text-[11px] text-muted-foreground">{item.badge}</div>
        ) : null}
        {item.description ? (
          <p className="text-xs leading-relaxed text-muted-foreground">{item.description}</p>
        ) : (
          <p className="text-xs italic text-muted-foreground">No description provided.</p>
        )}
      </PopoverContent>
    </Popover>
  );
}

/**
 * Render message text with @-mentions of known skills/plugins as clickable chips
 * (solid accent fill). Clicking a chip opens an overview popover. Tokens that no
 * longer resolve in the catalog render as plain (non-interactive) chips, and text
 * with no mentions renders verbatim.
 */
export function MentionText({ text, catalog }: { text: string; catalog: MentionCatalog }) {
  const segments = parseComposerSegments(text, catalog);
  return (
    <>
      {segments.map((segment, index) =>
        segment.type === "mention" ? (
          <MentionChip
            // index is stable for a derived, render-only projection of the text
            key={index}
            kind={segment.kind}
            name={segment.name}
            item={catalog.items.find(
              (entry) => entry.kind === segment.kind && entry.name === segment.name,
            )}
          />
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </>
  );
}
