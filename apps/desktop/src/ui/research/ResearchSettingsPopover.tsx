import { useAppStore } from "../../app/store";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Switch } from "../../components/ui/switch";
import { Button } from "../../components/ui/button";

export function ResearchSettingsPopover({ onOpenMcpPicker }: { onOpenMcpPicker: () => void }) {
  const settings = useAppStore((s) => s.researchDraftSettings);
  const setResearchDraftSettings = useAppStore((s) => s.setResearchDraftSettings);

  return (
    <Card className="border-border/70 bg-card/90 shadow-none">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Research settings</CardTitle>
        <CardDescription>
          Some controls are stored now but only forwarded once Google enables them for Deep Research.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-sm font-medium">Google Search</div>
            <div className="text-xs text-muted-foreground">Always on for the current Deep Research API.</div>
          </div>
          <Switch checked disabled aria-label="Google Search enabled" />
        </div>

        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-sm font-medium">URL Context</div>
            <div className="text-xs text-muted-foreground">Also always on for the current Deep Research API.</div>
          </div>
          <Switch checked disabled aria-label="URL Context enabled" />
        </div>

        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-sm font-medium">Code Execution</div>
            <div className="text-xs text-muted-foreground">Saved now, forwarded once Google supports it.</div>
          </div>
          <Switch
            checked={settings.codeExecution}
            aria-label="Code Execution"
            onCheckedChange={(checked) => setResearchDraftSettings({ codeExecution: checked })}
          />
        </div>

        <div className="space-y-2 rounded-xl border border-border/60 bg-muted/10 p-3">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="text-sm font-medium">MCP Servers</div>
              <div className="text-xs text-muted-foreground">
                Uses saved tokens from each server config once Deep Research exposes MCP pass-through.
              </div>
            </div>
            <Switch
              checked={settings.mcpServersEnabled}
              aria-label="MCP Servers"
              onCheckedChange={(checked) => setResearchDraftSettings({ mcpServersEnabled: checked })}
            />
          </div>
          <div className="flex items-center justify-between gap-3">
            <div className="text-xs text-muted-foreground">
              {settings.mcpServerNames.length > 0
                ? `${settings.mcpServerNames.length} server${settings.mcpServerNames.length === 1 ? "" : "s"} selected`
                : "No servers selected yet"}
            </div>
            <Button size="sm" variant="outline" type="button" onClick={onOpenMcpPicker}>
              Choose servers
            </Button>
          </div>
        </div>

        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-sm font-medium">Plan Approval</div>
            <div className="text-xs text-muted-foreground">UI-only for now; preserved so nothing is lost later.</div>
          </div>
          <Switch
            checked={settings.planApproval}
            aria-label="Plan Approval"
            onCheckedChange={(checked) => setResearchDraftSettings({ planApproval: checked })}
          />
        </div>
      </CardContent>
    </Card>
  );
}

