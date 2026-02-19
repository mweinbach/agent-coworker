import { AlertTriangleIcon } from "lucide-react";

import { Button } from "../../components/ui/button";
import { Card, CardContent } from "../../components/ui/card";
import { SettingsShell } from "../settings/SettingsShell";

interface SettingsContentProps {
  init: () => Promise<void>;
  ready: boolean;
  startupError: string | null;
}

export function SettingsContent({ init, ready, startupError }: SettingsContentProps) {
  if (!ready) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-lg font-semibold text-foreground">Starting...</div>
      </div>
    );
  }

  return (
    <>
      {startupError ? (
        <Card className="mx-5 mt-4 border-destructive/40 bg-destructive/10">
          <CardContent className="flex items-center justify-between gap-3 p-3">
            <div className="flex items-center gap-2 text-sm">
              <AlertTriangleIcon className="h-4 w-4 text-destructive" />
              <span>Running with fresh state due to an error.</span>
            </div>
            <Button variant="outline" size="sm" type="button" onClick={() => void init()}>
              Retry
            </Button>
          </CardContent>
        </Card>
      ) : null}
      <SettingsShell />
    </>
  );
}
