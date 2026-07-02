import { BrainCircuitIcon } from "lucide-react";
import { CATALOG_REASONING_EFFORT_VALUES } from "../../../../../src/shared/openaiCompatibleOptions";
import type { ReasoningEffortValue } from "../../app/openaiCompatibleProviderOptions";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { cn } from "../../lib/utils";

function reasoningEffortLabel(value: ReasoningEffortValue): string {
  switch (value) {
    case "none":
      return "Off";
    case "dynamic":
      return "Dynamic";
    case "xhigh":
      return "XHigh";
    case "max":
      return "Max";
    default:
      return value.charAt(0).toUpperCase() + value.slice(1);
  }
}

function reasoningEffortTitle(value: ReasoningEffortValue): string {
  return `Reasoning: ${reasoningEffortLabel(value)}`;
}

/**
 * Canonically ordered effort choices (Off → Max). The current value stays
 * selectable even when the model no longer advertises it.
 */
export function reasoningEffortOptions(
  value: ReasoningEffortValue,
  options: readonly ReasoningEffortValue[],
): ReasoningEffortValue[] {
  const present = new Set<ReasoningEffortValue>([value, ...options]);
  return CATALOG_REASONING_EFFORT_VALUES.filter((entry) => present.has(entry));
}

export function ComposerReasoningSelector({
  value,
  options,
  disabled,
  onChange,
}: {
  value: ReasoningEffortValue;
  options: readonly ReasoningEffortValue[];
  disabled?: boolean;
  onChange: (value: ReasoningEffortValue) => void;
}) {
  const choices = reasoningEffortOptions(value, options);
  const active = value !== "none";

  return (
    <Select
      value={value}
      onValueChange={(next) => onChange(next as ReasoningEffortValue)}
      disabled={disabled}
    >
      <SelectTrigger
        size="sm"
        aria-label="Reasoning effort"
        data-slot="composer-reasoning-selector"
        data-state={active ? "on" : "off"}
        title={reasoningEffortTitle(value)}
        className={cn(
          "h-7 gap-1 rounded-md border-transparent px-2 text-xs font-medium shadow-none [&_svg:not([class*='size-'])]:size-3",
          active
            ? "bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary [&_svg:not([class*='text-'])]:text-primary"
            : "text-muted-foreground/85 hover:bg-muted/30 hover:text-foreground",
        )}
      >
        <BrainCircuitIcon className="size-3.5" aria-hidden />
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="start" position="popper">
        {choices.map((entry) => (
          <SelectItem key={entry} value={entry}>
            {reasoningEffortLabel(entry)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function ComposerReasoningToggle({
  enabled,
  disabled,
  onChange,
}: {
  enabled: boolean;
  disabled?: boolean;
  onChange: (enabled: boolean) => void;
}) {
  return (
    <ComposerReasoningSelector
      value={enabled ? "high" : "none"}
      options={["none", "high"]}
      disabled={disabled}
      onChange={(next) => onChange(next !== "none")}
    />
  );
}
