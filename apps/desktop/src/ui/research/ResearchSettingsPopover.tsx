import {
  DEFAULT_RESEARCH_AGENT_ID,
  RESEARCH_AGENT_ID_VALUES,
  type ResearchSettings,
} from "../../../../../src/server/research/types";
import { useAppStore } from "../../app/store";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { Label } from "../../components/ui/label";
import { NativeSelect, NativeSelectOption } from "../../components/ui/native-select";
import { Switch } from "../../components/ui/switch";

const RESEARCH_AGENT_LABELS: Record<(typeof RESEARCH_AGENT_ID_VALUES)[number], string> = {
  "deep-research-pro-preview-12-2025": "Deep Research Pro (Dec 2025)",
  "deep-research-preview-04-2026": "Deep Research (Apr 2026)",
  "deep-research-max-preview-04-2026": "Deep Research Max (Apr 2026)",
};

export function ResearchSettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const settings = useAppStore((s) => s.researchDraftSettings);
  const setResearchDraftSettings = useAppStore((s) => s.setResearchDraftSettings);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton className="w-[min(96vw,28rem)]">
        <DialogHeader>
          <DialogTitle>Research settings</DialogTitle>
          <DialogDescription>
            Configure the Google Deep Research agent used for new research runs.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4 pt-2">
          <div className="grid gap-1.5">
            <Label htmlFor="research-agent-id">Research model</Label>
            <NativeSelect
              id="research-agent-id"
              size="sm"
              className="w-full"
              value={settings.agentId ?? DEFAULT_RESEARCH_AGENT_ID}
              onChange={(event) =>
                setResearchDraftSettings({
                  agentId: event.currentTarget.value as ResearchSettings["agentId"],
                })
              }
            >
              {RESEARCH_AGENT_ID_VALUES.map((agentId) => (
                <NativeSelectOption key={agentId} value={agentId}>
                  {RESEARCH_AGENT_LABELS[agentId]}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="research-thinking-summaries">Thought summaries</Label>
            <NativeSelect
              id="research-thinking-summaries"
              size="sm"
              className="w-full"
              value={settings.thinkingSummaries ?? "auto"}
              onChange={(event) =>
                setResearchDraftSettings({
                  thinkingSummaries: event.currentTarget
                    .value as ResearchSettings["thinkingSummaries"],
                })
              }
            >
              <NativeSelectOption value="auto">Auto</NativeSelectOption>
              <NativeSelectOption value="none">None</NativeSelectOption>
            </NativeSelect>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="research-visualization">Visualizations</Label>
            <NativeSelect
              id="research-visualization"
              size="sm"
              className="w-full"
              value={settings.visualization ?? "auto"}
              onChange={(event) =>
                setResearchDraftSettings({
                  visualization: event.currentTarget.value as ResearchSettings["visualization"],
                })
              }
            >
              <NativeSelectOption value="auto">Auto</NativeSelectOption>
              <NativeSelectOption value="off">Off</NativeSelectOption>
            </NativeSelect>
          </div>

          <div className="flex items-start justify-between gap-4 rounded-md border border-border/50 px-3 py-2.5">
            <div>
              <Label htmlFor="research-plan-approval" className="text-sm font-medium">
                Plan approval
              </Label>
              <div className="mt-0.5 text-xs text-muted-foreground">
                Review and approve the research plan before the agent continues.
              </div>
            </div>
            <Switch
              id="research-plan-approval"
              checked={settings.planApproval}
              aria-label="Plan approval"
              onCheckedChange={(checked) => setResearchDraftSettings({ planApproval: checked })}
            />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
