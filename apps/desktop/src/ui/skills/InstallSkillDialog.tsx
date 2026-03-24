import { useState } from "react";
import { Button } from "../../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../../components/ui/dialog";
import { Textarea } from "../../components/ui/textarea";
import { useAppStore } from "../../app/store";
import type { SkillMutationTargetScope } from "../../lib/wsProtocol";

export function InstallSkillDialog({
  workspaceId,
}: {
  workspaceId: string;
}) {
  const [open, setOpen] = useState(false);
  const [sourceInput, setSourceInput] = useState("");
  
  const wsRtById = useAppStore((s) => s.workspaceRuntimeById);
  const previewSkillInstall = useAppStore((s) => s.previewSkillInstall);
  const installSkills = useAppStore((s) => s.installSkills);
  
  const rt = wsRtById[workspaceId];
  const mutationBlocked = rt?.skillsMutationBlocked ?? false;
  const mutationBlockedReason = rt?.skillsMutationBlockedReason ?? null;
  const skillInstallInFlight = Object.keys(rt?.skillMutationPendingKeys ?? {}).some((k) => k.startsWith("install:"));

  const handlePreview = async (targetScope: SkillMutationTargetScope) => {
    if (!sourceInput.trim()) return;
    await previewSkillInstall(sourceInput, targetScope);
  };

  const handleInstall = async (targetScope: SkillMutationTargetScope) => {
    if (!sourceInput.trim()) return;
    try {
      await installSkills(sourceInput, targetScope);
      setOpen(false);
      setSourceInput("");
    } catch {
      // Server failures surface as `skillMutationError` above; connection/superseded errors reject here.
    }
  };

  return (
    <>
      <Button size="sm" className="rounded-full px-4" type="button" onClick={() => setOpen(true)}>
        + New skill
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>Install from source</DialogTitle>
            <DialogDescription>
              Paste a `skills.sh` URL, GitHub URL, `owner/repo`, or local path.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <Textarea
              className="min-h-24 w-full"
              placeholder="https://skills.sh/openai/skills/imagegen"
              value={sourceInput}
              onChange={(event) => setSourceInput(event.target.value)}
            />
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={() => void handlePreview("project")} type="button">
                  Preview in Workspace
                </Button>
                <Button variant="outline" size="sm" onClick={() => void handlePreview("global")} type="button">
                  Preview in Library
                </Button>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  disabled={mutationBlocked || skillInstallInFlight}
                  onClick={() => void handleInstall("project")}
                  type="button"
                >
                  Install to Workspace
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={mutationBlocked || skillInstallInFlight}
                  onClick={() => void handleInstall("global")}
                  type="button"
                >
                  Install to Cowork Library
                </Button>
              </div>
            </div>
            {rt?.skillMutationError ? (
              <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                {rt.skillMutationError}
              </div>
            ) : null}
            {mutationBlockedReason ? (
              <div className="rounded-md border border-border/70 bg-muted/25 px-3 py-2 text-xs text-muted-foreground">
                {mutationBlockedReason}
              </div>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
