import { PlusIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { useAppStore } from "../../../app/store";
import { operationKey } from "../../../app/store.helpers";
import { isOneOffChatWorkspace } from "../../../app/types";
import { Button } from "../../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../../components/ui/dialog";
import { Textarea } from "../../../components/ui/textarea";
import type { SkillMutationTargetScope } from "../../../lib/wsProtocol";
import { OperationFeedback } from "../../OperationFeedback";

type SkillPreviewState = NonNullable<
  ReturnType<typeof useAppStore.getState>["workspaceRuntimeById"][string]["selectedSkillPreview"]
>;

function skillTargetLabel(targetScope: SkillMutationTargetScope): string {
  return targetScope === "project" ? "workspace" : "Cowork Library";
}

function skillScopeLabel(scope: string | undefined): string {
  if (scope === "project") return "Workspace";
  if (scope === "user" || scope === "global") return "Library";
  if (scope === "built-in") return "Built-in";
  return "Shadowed";
}

function skillPreviewSummary(preview: SkillPreviewState) {
  const validCount = preview.candidates.filter(
    (candidate) => candidate.diagnostics.length === 0,
  ).length;
  if (validCount === 0) {
    return "No valid skills found";
  }
  return validCount === 1 ? "1 skill ready" : `${validCount} skills ready`;
}

function isSkillPreviewVisibleForInput(opts: {
  normalizedSourceInput: string;
  lastPreviewSourceInput: string | null;
  lastPreviewTargetScope: SkillMutationTargetScope | null;
  skillPreview: SkillPreviewState | null;
}): boolean {
  const previewMatchesCurrentInput =
    opts.lastPreviewSourceInput !== null &&
    opts.normalizedSourceInput.length > 0 &&
    opts.normalizedSourceInput === opts.lastPreviewSourceInput;
  return Boolean(
    opts.skillPreview &&
      previewMatchesCurrentInput &&
      opts.lastPreviewTargetScope !== null &&
      opts.skillPreview.targetScope === opts.lastPreviewTargetScope,
  );
}

export function shouldRequireFreshSkillPreviewForScope(opts: {
  normalizedSourceInput: string;
  lastPreviewSourceInput: string | null;
  lastPreviewTargetScope: SkillMutationTargetScope | null;
  skillPreview: SkillPreviewState | null;
  targetScope: SkillMutationTargetScope;
}): boolean {
  return (
    isSkillPreviewVisibleForInput(opts) &&
    opts.lastPreviewTargetScope !== null &&
    opts.lastPreviewTargetScope !== opts.targetScope
  );
}

export function shouldDisableSkillInstallForScope(opts: {
  normalizedSourceInput: string;
  lastPreviewSourceInput: string | null;
  lastPreviewTargetScope: SkillMutationTargetScope | null;
  skillPreview: SkillPreviewState | null;
  targetScope: SkillMutationTargetScope;
  skillInstallInFlight: boolean;
  mutationBlocked: boolean;
}): boolean {
  if (opts.mutationBlocked || opts.skillInstallInFlight) {
    return true;
  }
  if (shouldRequireFreshSkillPreviewForScope(opts)) {
    return true;
  }
  const previewVisible = isSkillPreviewVisibleForInput(opts);
  if (!previewVisible || opts.lastPreviewTargetScope !== opts.targetScope) {
    return false;
  }
  return (
    (opts.skillPreview?.candidates.some((candidate) => candidate.diagnostics.length === 0) ??
      false) === false
  );
}

export function InstallSkillDialog({
  workspaceId,
  initialOpen = false,
  initialSourceInput = "",
  initialMutationSourceInput = null,
}: {
  workspaceId: string;
  initialOpen?: boolean;
  initialSourceInput?: string;
  initialMutationSourceInput?: string | null;
}) {
  const [open, setOpen] = useState(initialOpen);
  const [sourceInput, setSourceInput] = useState(initialSourceInput);
  const [lastPreviewSourceInput, setLastPreviewSourceInput] = useState<string | null>(null);
  const [lastPreviewTargetScope, setLastPreviewTargetScope] =
    useState<SkillMutationTargetScope | null>(null);
  const [lastMutationSourceInput, setLastMutationSourceInput] = useState<string | null>(
    initialMutationSourceInput,
  );
  const [lastMutationTargetScope, setLastMutationTargetScope] =
    useState<SkillMutationTargetScope | null>(null);

  const wsRtById = useAppStore((s) => s.workspaceRuntimeById);
  const previewSkillInstall = useAppStore((s) => s.previewSkillInstall);
  const installSkills = useAppStore((s) => s.installSkills);
  const installOperation = useAppStore(
    (state) => state.operationsByKey[operationKey("skill", "install")],
  );
  const anchorWorkspace = useAppStore(
    (s) => s.workspaces.find((workspace) => workspace.id === workspaceId) ?? null,
  );
  // One-off chat anchors have no project directory, so only the global scope
  // (~/.cowork/skills) is a valid install target.
  const projectScopeAvailable = !isOneOffChatWorkspace(anchorWorkspace);

  const rt = wsRtById[workspaceId];
  const mutationBlocked = rt?.skillsMutationBlocked ?? false;
  const mutationBlockedReason = rt?.skillsMutationBlockedReason ?? null;
  const skillInstallInFlight = Object.keys(rt?.skillMutationPendingKeys ?? {}).some((k) =>
    k.startsWith("install:"),
  );
  const skillPreview = rt?.selectedSkillPreview ?? null;
  const skillPreviewPending = rt?.skillMutationPendingKeys.preview === true;
  const normalizedSourceInput = sourceInput.trim();
  const showPreview = isSkillPreviewVisibleForInput({
    normalizedSourceInput,
    lastPreviewSourceInput,
    lastPreviewTargetScope,
    skillPreview,
  });
  const showPreviewPending =
    skillPreviewPending &&
    lastPreviewSourceInput !== null &&
    normalizedSourceInput.length > 0 &&
    normalizedSourceInput === lastPreviewSourceInput;
  const showMutationError =
    Boolean(rt?.skillMutationError) &&
    lastMutationSourceInput !== null &&
    normalizedSourceInput.length > 0 &&
    normalizedSourceInput === lastMutationSourceInput;
  const dialogError = showMutationError ? (rt?.skillMutationError ?? null) : null;
  const disableInstallForScope = (targetScope: SkillMutationTargetScope) =>
    shouldDisableSkillInstallForScope({
      normalizedSourceInput,
      lastPreviewSourceInput,
      lastPreviewTargetScope,
      skillPreview,
      targetScope,
      skillInstallInFlight,
      mutationBlocked,
    });

  const validPreviewCandidates = useMemo(
    () =>
      showPreview
        ? (skillPreview?.candidates.filter((candidate) => candidate.diagnostics.length === 0) ?? [])
        : [],
    [skillPreview, showPreview],
  );

  const resetDialogState = () => {
    setSourceInput("");
    setLastPreviewSourceInput(null);
    setLastPreviewTargetScope(null);
    setLastMutationSourceInput(null);
    setLastMutationTargetScope(null);
  };

  const openDialog = () => {
    resetDialogState();
    setOpen(true);
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && skillInstallInFlight) {
      return;
    }
    if (!nextOpen && !open) {
      return;
    }
    setOpen(nextOpen);
    if (!nextOpen) {
      resetDialogState();
    }
  };

  const handlePreview = async (targetScope: SkillMutationTargetScope) => {
    if (!normalizedSourceInput) return;
    setLastMutationSourceInput(normalizedSourceInput);
    setLastMutationTargetScope(targetScope);
    setLastPreviewSourceInput(normalizedSourceInput);
    setLastPreviewTargetScope(targetScope);
    await previewSkillInstall(normalizedSourceInput, targetScope);
  };

  const handleInstall = async (targetScope: SkillMutationTargetScope) => {
    if (!normalizedSourceInput) return;
    setLastMutationSourceInput(normalizedSourceInput);
    setLastMutationTargetScope(targetScope);
    const result = await installSkills(normalizedSourceInput, targetScope);
    if (result.ok) {
      handleOpenChange(false);
    }
  };

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        type="button"
        onPointerDown={openDialog}
        onClick={openDialog}
      >
        <PlusIcon data-icon="inline-start" />
        New skill
      </Button>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle>Install skill from source</DialogTitle>
            <DialogDescription>
              Paste a `skills.sh` URL, GitHub URL, `owner/repo`, or local path.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <Textarea
              className="min-h-24 w-full"
              placeholder="https://skills.sh/example/skills/imagegen"
              value={sourceInput}
              disabled={skillInstallInFlight}
              aria-label="Skill source"
              onChange={(event) => {
                setSourceInput(event.target.value);
                setLastPreviewSourceInput(null);
                setLastPreviewTargetScope(null);
                setLastMutationSourceInput(null);
                setLastMutationTargetScope(null);
              }}
            />
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap gap-2">
                {projectScopeAvailable ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={skillInstallInFlight}
                    onClick={() => void handlePreview("project")}
                    type="button"
                  >
                    Preview in Workspace
                  </Button>
                ) : null}
                <Button
                  variant="outline"
                  size="sm"
                  disabled={skillInstallInFlight}
                  onClick={() => void handlePreview("global")}
                  type="button"
                >
                  Preview in Library
                </Button>
              </div>
              <div className="flex flex-wrap gap-2">
                {projectScopeAvailable ? (
                  <Button
                    size="sm"
                    disabled={disableInstallForScope("project")}
                    onClick={() => void handleInstall("project")}
                    type="button"
                  >
                    Install to Workspace
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={disableInstallForScope("global")}
                  onClick={() => void handleInstall("global")}
                  type="button"
                >
                  Install to Cowork Library
                </Button>
              </div>
            </div>

            {showPreviewPending ? (
              <div className="rounded-md border border-border/70 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                Previewing skill source...
              </div>
            ) : null}

            {showPreview ? (
              <div className="rounded-md border border-border/70 bg-muted/20 px-3 py-3 text-xs text-muted-foreground">
                <div className="font-medium text-foreground">
                  {skillPreview ? skillPreviewSummary(skillPreview) : "No skill preview"}
                </div>
                <div className="mt-1 text-[11px] text-muted-foreground">
                  Previewed for{" "}
                  {skillPreview?.targetScope ? skillTargetLabel(skillPreview.targetScope) : "skill"}{" "}
                  install.
                </div>
                <div className="mt-2 space-y-1.5">
                  {skillPreview?.candidates.map((candidate) => (
                    <div
                      key={`${candidate.name}:${candidate.relativeRootPath}`}
                      className="rounded border border-border/60 bg-background/40 px-2.5 py-2"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate font-medium text-foreground">
                            {candidate.name}
                          </div>
                          <div className="truncate text-[11px] text-muted-foreground">
                            {candidate.relativeRootPath}
                          </div>
                        </div>
                        <div className="shrink-0 text-[11px] text-muted-foreground">
                          {candidate.conflictsWithScope
                            ? skillScopeLabel(candidate.conflictsWithScope)
                            : candidate.wouldBeEffective
                              ? "Effective"
                              : "Shadowed"}
                        </div>
                      </div>
                      <div className="mt-1 text-[11px] text-muted-foreground">
                        {candidate.description}
                      </div>
                      {candidate.diagnostics.length > 0 ? (
                        <div className="mt-2 space-y-1 text-[11px] text-destructive">
                          {candidate.diagnostics.map((diagnostic) => (
                            <div key={`${candidate.name}:${diagnostic.code}`}>
                              {diagnostic.message}
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
                {(skillPreview?.warnings?.length ?? 0) > 0 ? (
                  <div className="mt-2 space-y-1 text-[11px] text-destructive">
                    {skillPreview?.warnings.map((warning) => (
                      <div key={warning}>{warning}</div>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}

            {dialogError ? (
              <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                {dialogError}
              </div>
            ) : null}
            <OperationFeedback operation={installOperation} />
            {dialogError && lastMutationTargetScope ? (
              <div className="text-[11px] text-muted-foreground">
                Last attempted target: {skillTargetLabel(lastMutationTargetScope)}.
              </div>
            ) : null}
            {mutationBlockedReason ? (
              <div className="rounded-md border border-border/70 bg-muted/25 px-3 py-2 text-xs text-muted-foreground">
                {mutationBlockedReason}
              </div>
            ) : null}
            {showPreview && projectScopeAvailable ? (
              <div className="text-[11px] text-muted-foreground">
                To install to{" "}
                {lastPreviewTargetScope === "project" ? "Cowork Library" : "workspace"}, run a new
                preview for that scope first.
              </div>
            ) : null}
            {showPreview && validPreviewCandidates.length === 0 ? (
              <div className="rounded-md border border-border/70 bg-muted/25 px-3 py-2 text-xs text-muted-foreground">
                Fix the preview issues before installing this skill source.
              </div>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
