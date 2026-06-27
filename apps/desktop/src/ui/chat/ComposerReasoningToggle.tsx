import { BrainCircuitIcon } from "lucide-react";
import { Button } from "../../components/ui/button";
import { cn } from "../../lib/utils";

export function ComposerReasoningToggle({
  enabled,
  disabled,
  onChange,
}: {
  enabled: boolean;
  disabled?: boolean;
  onChange: (enabled: boolean) => void;
}) {
  const stateLabel = enabled ? "on" : "off";

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      aria-label={`Reasoning ${stateLabel}`}
      aria-pressed={enabled}
      data-slot="composer-reasoning-toggle"
      data-state={enabled ? "on" : "off"}
      title={`Reasoning ${stateLabel}`}
      disabled={disabled}
      onClick={() => onChange(!enabled)}
      className={cn(
        "h-7 gap-1.5 rounded-md px-2 text-xs font-medium shadow-none transition-colors",
        enabled
          ? "bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary"
          : "text-muted-foreground/85 hover:bg-muted/30 hover:text-foreground",
      )}
    >
      <BrainCircuitIcon className="size-3.5" aria-hidden />
      <span>Reasoning</span>
    </Button>
  );
}
