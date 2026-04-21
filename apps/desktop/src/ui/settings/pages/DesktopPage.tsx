import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../../components/ui/card";
import { showQuickChatWindow } from "../../../lib/desktopCommands";

export function DesktopPage() {
  return (
    <Card className="border-border/80 bg-card/85">
      <CardHeader>
        <CardTitle>Quick chat</CardTitle>
        <CardDescription>
          Open the lighter-weight floating chat surface without bringing the full app window forward.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-xl border border-border/70 bg-muted/15 p-4">
          <div className="text-sm font-medium text-foreground">Compact popup</div>
          <div className="mt-1 text-xs text-muted-foreground">
            Menu bar / tray visibility and the optional global shortcut are controlled from Feature Settings.
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={() => void showQuickChatWindow()}>
            Open quick chat
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
