import { useEffect, useState } from "react";
import { Streamdown } from "streamdown";
import { useAppStore } from "../../app/store";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "../../components/ui/dialog";
import { revealPath } from "../../lib/desktopCommands";
import { actionPending, normalizeDisplayContent, scopeLabel, skillSourceLabel, stateTone, SkillIcon } from "./utils";
import { ExternalLinkIcon } from "lucide-react";

export function SkillDetailDialog({ workspaceId }: { workspaceId: string }) {
  const [dismissedInstallationId, setDismissedInstallationId] = useState<string | null>(null);
  const wsRtById = useAppStore((s) => s.workspaceRuntimeById);
  const selectSkillInstallation = useAppStore((s) => s.selectSkillInstallation);
  const disableSkillInstallation = useAppStore((s) => s.disableSkillInstallation);
  const enableSkillInstallation = useAppStore((s) => s.enableSkillInstallation);
  const deleteSkillInstallation = useAppStore((s) => s.deleteSkillInstallation);
  const copySkillInstallation = useAppStore((s) => s.copySkillInstallation);
  const checkSkillInstallationUpdate = useAppStore((s) => s.checkSkillInstallationUpdate);
  const updateSkillInstallation = useAppStore((s) => s.updateSkillInstallation);

  const rt = wsRtById[workspaceId];
  const skills = rt?.skills ?? [];
  const selectedSkillName = rt?.selectedSkillName ?? null;
  const content = rt?.selectedSkillContent ?? null;
  const selectedSkill = skills.find((s) => s.name === selectedSkillName) ?? null;
  const selectedInstallation = rt?.selectedSkillInstallation ?? null;
  const selectedSkillInstallationId = rt?.selectedSkillInstallationId ?? null;
  const deletePending = selectedInstallation ? actionPending(rt, "delete", selectedInstallation.installationId) : false;
  const isDismissedAfterDelete =
    selectedSkillInstallationId !== null && dismissedInstallationId === selectedSkillInstallationId;
  const isOpen = !isDismissedAfterDelete && (selectedSkillInstallationId !== null || selectedSkillName !== null);

  useEffect(() => {
    if (!dismissedInstallationId) {
      return;
    }
    if (selectedSkillInstallationId !== dismissedInstallationId || !deletePending) {
      setDismissedInstallationId(null);
    }
  }, [deletePending, dismissedInstallationId, selectedSkillInstallationId]);

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      void selectSkillInstallation(null);
    }
  };

  if (!isOpen) return null;

  const selectedDisplayName =
    selectedInstallation?.interface?.displayName ||
    selectedInstallation?.name ||
    selectedSkill?.interface?.displayName ||
    selectedSkill?.name ||
    selectedSkillName ||
    "";

  const selectedDescription =
    selectedInstallation?.interface?.shortDescription ||
    selectedInstallation?.description ||
    selectedSkill?.interface?.shortDescription ||
    selectedSkill?.description ||
    "";

  const safeContent = normalizeDisplayContent(content);
  const updateCheck = selectedInstallation ? rt?.skillUpdateChecksByInstallationId[selectedInstallation.installationId] ?? null : null;
  const mutationBlocked = rt?.skillsMutationBlocked ?? false;

  const isLoading = selectedSkillInstallationId !== null && selectedInstallation === null;

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto flex flex-col gap-0 p-0">
        {isLoading ? (
          <div className="flex items-center justify-center p-12 text-muted-foreground">
            Loading...
          </div>
        ) : (
          <>
            <div className="p-6 pb-4 border-b border-border/50">
          <DialogHeader className="space-y-4">
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-start gap-4">
                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-muted/50 border border-border/50 text-2xl overflow-hidden">
                  <SkillIcon icon={selectedInstallation?.interface?.iconLarge || selectedInstallation?.interface?.iconSmall || selectedSkill?.interface?.iconLarge || selectedSkill?.interface?.iconSmall || "📦"} />
                </div>
                <div className="space-y-1">
                  <DialogTitle className="text-xl">{selectedDisplayName}</DialogTitle>
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <span>{selectedInstallation ? scopeLabel(selectedInstallation.scope) : selectedSkill ? skillSourceLabel(selectedSkill.source) : "Unknown"}</span>
                    {selectedInstallation?.origin?.kind && (
                      <>
                        <span>·</span>
                        <span>{selectedInstallation.origin.kind}</span>
                      </>
                    )}
                    {selectedInstallation && (
                      <Button
                        type="button"
                        variant="link"
                        className="h-auto p-0 text-muted-foreground hover:text-foreground"
                        onClick={() => {
                          void revealPath({ path: selectedInstallation.rootDir });
                        }}
                      >
                        <span className="flex items-center gap-1">
                          Open folder <ExternalLinkIcon className="h-3 w-3" />
                        </span>
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            </div>
            <DialogDescription className="text-base text-foreground">
              {selectedDescription}
            </DialogDescription>
          </DialogHeader>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {selectedInstallation && (
            <div className="flex flex-wrap gap-2">
              <Badge variant={stateTone(selectedInstallation.state)}>{selectedInstallation.state}</Badge>
              <Badge variant="secondary">{scopeLabel(selectedInstallation.scope)}</Badge>
              <Badge variant="outline">{selectedInstallation.writable ? "Writable" : "Read-only"}</Badge>
              {selectedInstallation.managed ? <Badge variant="outline">Managed</Badge> : <Badge variant="outline">Unmanaged</Badge>}
            </div>
          )}

          {selectedInstallation?.diagnostics && selectedInstallation.diagnostics.length > 0 && (
            <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 space-y-2 text-sm">
              <div className="font-semibold text-destructive">Diagnostics</div>
              {selectedInstallation.diagnostics.map((diagnostic) => (
                <div key={diagnostic.code} className="text-destructive">
                  {diagnostic.message}
                </div>
              ))}
            </div>
          )}

          {updateCheck && !updateCheck.canUpdate && (
            <div className="rounded-md border border-border/70 bg-muted/25 px-3 py-2 text-sm text-muted-foreground">
              {updateCheck.reason}
            </div>
          )}

          <div className="text-sm">
            {safeContent ? (
              <Streamdown className="max-w-none leading-7 [&>*:first-child]:mt-0 [&_a]:underline [&_code]:rounded-sm [&_code]:bg-muted/45 [&_code]:px-1.5 [&_code]:py-0.5 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:border-border/80 [&_pre]:bg-muted/35 [&_pre]:p-3">
                {safeContent}
              </Streamdown>
            ) : (
              <div className="text-muted-foreground">
                {selectedInstallation?.skillPath ? "Loading skill documentation..." : "This installation does not have readable skill content."}
              </div>
            )}
          </div>
        </div>

        <div className="p-4 border-t border-border/50 bg-muted/10 flex items-center justify-between">
          <div className="flex items-center gap-2">
            {selectedInstallation?.writable ? (
              <Button
                variant="destructive"
                size="sm"
                className="bg-destructive/10 text-destructive hover:bg-destructive/20 border-transparent"
                disabled={mutationBlocked || deletePending}
                onClick={() => {
                  setDismissedInstallationId(selectedInstallation.installationId);
                  void deleteSkillInstallation(selectedInstallation.installationId);
                }}
              >
                Uninstall
              </Button>
            ) : null}
            
            {selectedInstallation?.writable ? (
              selectedInstallation.enabled ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={mutationBlocked || actionPending(rt, "disable", selectedInstallation.installationId)}
                  onClick={() => void disableSkillInstallation(selectedInstallation.installationId)}
                >
                  Disable
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={mutationBlocked || actionPending(rt, "enable", selectedInstallation.installationId)}
                  onClick={() => void enableSkillInstallation(selectedInstallation.installationId)}
                >
                  Enable
                </Button>
              )
            ) : null}
          </div>
          
          <div className="flex items-center gap-2">
            {selectedInstallation?.writable && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={mutationBlocked}
                  onClick={() => void checkSkillInstallationUpdate(selectedInstallation.installationId)}
                >
                  Check update
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={mutationBlocked || !updateCheck?.canUpdate || actionPending(rt, "update", selectedInstallation.installationId)}
                  onClick={() => void updateSkillInstallation(selectedInstallation.installationId)}
                >
                  Update
                </Button>
              </>
            )}
            
            {!selectedInstallation?.writable && selectedInstallation && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={mutationBlocked}
                  onClick={() => void copySkillInstallation(selectedInstallation.installationId, "project")}
                >
                  Copy to Workspace
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={mutationBlocked}
                  onClick={() => void copySkillInstallation(selectedInstallation.installationId, "global")}
                >
                  Copy to Library
                </Button>
              </>
            )}
            
            <Button size="sm" onClick={() => handleOpenChange(false)}>
              Close
            </Button>
          </div>
        </div>
        </>
        )}
      </DialogContent>
    </Dialog>
  );
}
