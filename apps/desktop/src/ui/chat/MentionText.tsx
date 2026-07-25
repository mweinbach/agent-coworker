import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  MENTION_CHIP_PADDED_CLASS,
  type MentionCatalog,
  type MentionItem,
  type MentionKind,
  parseComposerSegments,
} from "./composerMentions";

function MentionChip(props: { kind: MentionKind; name: string; item: MentionItem | undefined }) {
  const { kind, name, item } = props;
  const label = `@${name}`;

  // Unknown / stale reference (no longer in the catalog): styled, but not clickable.
  if (!item) {
    return <span className={cn(MENTION_CHIP_PADDED_CLASS, "inline opacity-80")}>{label}</span>;
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            MENTION_CHIP_PADDED_CLASS,
            "inline cursor-pointer align-baseline transition-colors hover:bg-primary/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
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
          <Badge variant="secondary" className="ml-auto shrink-0 text-xs">
            {kind === "skill" ? "Skill" : "Plugin"}
          </Badge>
        </div>
        {item.badge ? (
          <div className="mb-1.5 text-xs text-muted-foreground">{item.badge}</div>
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
      {segments.map((segment) =>
        segment.type === "mention" ? (
          <MentionChip
            key={`mention:${segment.kind}:${segment.name}:${segment.start}:${segment.end}`}
            kind={segment.kind}
            name={segment.name}
            item={catalog.items.find(
              (entry) => entry.kind === segment.kind && entry.name === segment.name,
            )}
          />
        ) : (
          <span key={`text:${segment.start}:${segment.end}`}>{segment.text}</span>
        ),
      )}
    </>
  );
}
