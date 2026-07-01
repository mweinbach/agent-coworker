import { BrainCircuitIcon } from "lucide-react";
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
      return "Max";
    default:
      return value.charAt(0).toUpperCase() + value.slice(1);
  }
}

function reasoningEffortTitle(value: ReasoningEffortValue): string {
  return `Reasoning: ${reasoningEffortLabel(value)}`;
}

function reasoningEffortOptions(
  value: ReasoningEffortValue,
  options: readonly ReasoningEffortValue[],
): ReasoningEffortValue[] {
  const out: ReasoningEffortValue[] = [];
  for (const entry of [value, ...options]) {
    if (!out.includes(entry)) out.push(entry);
  }
  return out;
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
          "h-7 gap-1.5 rounded-md border-transparent px-2 text-xs font-medium shadow-none",
          active
            ? "bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary"
            : "text-muted-foreground/85 hover:bg-muted/30 hover:text-foreground",
        )}
      >
        <BrainCircuitIcon aria-hidden />
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
