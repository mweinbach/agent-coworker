import { useAppStore } from "../../../app/store";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../../components/ui/card";
import { Checkbox } from "../../../components/ui/checkbox";

function toBoolean(checked: boolean | "indeterminate"): boolean {
  return checked === true;
}

export function DeveloperPage() {
  const developerMode = useAppStore((s) => s.developerMode);
  const setDeveloperMode = useAppStore((s) => s.setDeveloperMode);

  const showHiddenFiles = useAppStore((s) => s.showHiddenFiles);
  const setShowHiddenFiles = useAppStore((s) => s.setShowHiddenFiles);

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight text-foreground">Developer</h1>
        <p className="text-sm text-muted-foreground">Advanced settings and debugging tools.</p>
      </div>

      <Card className="border-border/80 bg-card/85">
        <CardHeader>
          <CardTitle>File Explorer</CardTitle>
          <CardDescription>Configure how files are displayed in the workspace.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-start justify-between gap-4 max-[960px]:flex-col">
            <div>
              <div className="text-sm font-medium">Show hidden files</div>
              <div className="text-xs text-muted-foreground">Display dotfiles and other hidden system files.</div>
            </div>
            <Checkbox
              checked={showHiddenFiles}
              aria-label="Show hidden files"
              onCheckedChange={(checked) => setShowHiddenFiles(toBoolean(checked))}
            />
          </div>
        </CardContent>
      </Card>

      <Card className="border-border/80 bg-card/85">
        <CardHeader>
          <CardTitle>System & Debugging</CardTitle>
          <CardDescription>Internal visibility and event tracking.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-start justify-between gap-4 max-[960px]:flex-col">
            <div>
              <div className="text-sm font-medium">Developer mode</div>
              <div className="text-xs text-muted-foreground">Show internal system notices in the chat feed.</div>
            </div>
            <Checkbox
              checked={developerMode}
              aria-label="Enable developer mode"
              onCheckedChange={(checked) => setDeveloperMode(toBoolean(checked))}
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
