import { useMemo, useState } from "react";
import { Streamdown } from "streamdown";

import { useAppStore } from "../app/store";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { openPath, revealPath } from "../lib/desktopCommands";
import type { SkillEntry, SkillInstallationEntry, SkillMutationTargetScope } from "../lib/wsProtocol";
import { cn } from "../lib/utils";

function skillSourceLabel(source: SkillEntry["source"]): string {
  switch (source) {
    case "project":
      return "Workspace";
    case "global":
      return "Global";
    case "user":
      return "User";
    case "built-in":
      return "Built-in";
    default:
      return "Unknown";
  }
}

function stripYamlFrontMatter(raw: string): string {
  const re = /^\ufeff?---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/;
  return raw.replace(re, "").trimStart();
}

function scopeLabel(scope: SkillInstallationEntry["scope"]): string {
  switch (scope) {
    case "project":
      return "Workspace";
    case "global":
      return "Cowork Library";
    case "user":
      return "User";
    case "built-in":
      return "Built-in";
    default:
      return scope;
  }
}

function stateTone(state: SkillInstallationEntry["state"]): "default" | "secondary" | "outline" {
  switch (state) {
    case "effective":
      return "default";
    case "disabled":
    case "shadowed":
    case "invalid":
      return "secondary";
    default:
      return "outline";
  }
}

function normalizeDisplayContent(raw: string | null): string | null {
  if (!raw) return null;
  return stripYamlFrontMatter(raw);
}

function actionPending(rt: ReturnType<typeof useAppStore.getState>["workspaceRuntimeById"][string] | undefined, prefix: string, id?: string): boolean {
  if (!rt) return false;
  const key = id ? `${prefix}:${id}` : prefix;
  return rt.skillMutationPendingKeys[key] === true;
}

function SortableInstallations({ installations, selectedId, onSelect }: {
  installations: SkillInstallationEntry[];
  selectedId: string | null;
  onSelect: (installationId: string) => void;
}) {
  return (
    <div className="space-y-1">
      {installations.map((installation) => {
        const active = installation.installationId === selectedId;
        return (
          <Button
            key={installation.installationId}
            variant={active ? "secondary" : "ghost"}
            className={cn("h-auto w-full justify-start px-3 py-2 text-left", active ? "border border-border/70" : "")}
            onClick={() => onSelect(installation.installationId)}
            type="button"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <div className="truncate font-semibold text-sm">
                  {installation.interface?.displayName || installation.name}
                </div>
                <Badge variant={stateTone(installation.state)}>{installation.state}</Badge>
              </div>
              <div className="truncate text-xs text-muted-foreground">
                {scopeLabel(installation.scope)} · {installation.description}
              </div>
            </div>
          </Button>
        );
      })}
    </div>
  );
}

export function SkillsView() {
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const workspaces = useAppStore((s) => s.workspaces);
  const wsRtById = useAppStore((s) => s.workspaceRuntimeById);
  const refreshSkillsCatalog = useAppStore((s) => s.refreshSkillsCatalog);
  const selectSkillInstallation = useAppStore((s) => s.selectSkillInstallation);
  const previewSkillInstall = useAppStore((s) => s.previewSkillInstall);
  const installSkills = useAppStore((s) => s.installSkills);
  const disableSkillInstallation = useAppStore((s) => s.disableSkillInstallation);
  const enableSkillInstallation = useAppStore((s) => s.enableSkillInstallation);
  const deleteSkillInstallation = useAppStore((s) => s.deleteSkillInstallation);
  const copySkillInstallation = useAppStore((s) => s.copySkillInstallation);
  const checkSkillInstallationUpdate = useAppStore((s) => s.checkSkillInstallationUpdate);
  const updateSkillInstallation = useAppStore((s) => s.updateSkillInstallation);
  const [sourceInput, setSourceInput] = useState("");

  if (!selectedWorkspaceId) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <h2 className="text-2xl font-semibold tracking-tight">Pick a workspace</h2>
        <p className="text-sm text-muted-foreground">Select a workspace to view available skills.</p>
      </div>
    );
  }

  const ws = workspaces.find((w) => w.id === selectedWorkspaceId);
  const rt = wsRtById[selectedWorkspaceId];
  const catalog = rt?.skillsCatalog ?? null;
  const skills = rt?.skills ?? [];
  const selectedSkillName = rt?.selectedSkillName ?? null;
  const content = rt?.selectedSkillContent ?? null;
  const selectedSkill = skills.find((s) => s.name === selectedSkillName) ?? null;
  const selectedInstallation = rt?.selectedSkillInstallation ?? null;
  const selectedDisplayName =
    selectedInstallation?.interface?.displayName
    || selectedInstallation?.name
    || selectedSkill?.interface?.displayName
    || selectedSkill?.name
    || selectedSkillName
    || "";
  const selectedDescription =
    selectedInstallation?.interface?.shortDescription
    || selectedInstallation?.description
    || selectedSkill?.interface?.shortDescription
    || selectedSkill?.description
    || "";
  const safeContent = normalizeDisplayContent(content);
  const installations = useMemo(
    () => [...(catalog?.installations ?? [])].sort((left, right) =>
      `${left.name}:${left.scope}:${left.installationId}`.localeCompare(`${right.name}:${right.scope}:${right.installationId}`),
    ),
    [catalog],
  );
  const effectiveSkills = catalog?.effectiveSkills ?? [];
  const updateCheck = selectedInstallation ? rt?.skillUpdateChecksByInstallationId[selectedInstallation.installationId] ?? null : null;
  const mutationBlocked = rt?.skillsMutationBlocked ?? false;
  const mutationBlockedReason = rt?.skillsMutationBlockedReason ?? null;

  const handlePreview = async (targetScope: SkillMutationTargetScope) => {
    if (!sourceInput.trim()) return;
    await previewSkillInstall(sourceInput, targetScope);
  };

  const handleInstall = async (targetScope: SkillMutationTargetScope) => {
    if (!sourceInput.trim()) return;
    await installSkills(sourceInput, targetScope);
  };

  return (
    <div className="grid h-full min-h-0 grid-cols-[360px_minmax(0,1fr)] bg-panel max-[1100px]:grid-cols-1">
      <aside className="min-h-0 overflow-auto border-r border-border/70 bg-sidebar p-3 max-[1100px]:border-r-0 max-[1100px]:border-b">
        <div className="mb-4 flex items-center justify-between gap-2">
          <div>
            <div className="text-lg font-semibold">Skills</div>
            <div className="text-xs text-muted-foreground">{ws?.name || "Workspace"}</div>
          </div>
          <Button variant="outline" size="sm" onClick={() => void refreshSkillsCatalog()} type="button">
            Refresh
          </Button>
        </div>

        <Card className="mb-3 border-border/80 bg-card/70">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Install from source</CardTitle>
            <CardDescription>
              Paste a `skills.sh` URL, GitHub URL, `owner/repo`, or local path.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <textarea
              className="min-h-24 w-full rounded-md border border-border/70 bg-background px-3 py-2 text-sm outline-none"
              placeholder="https://skills.sh/openai/skills/imagegen"
              value={sourceInput}
              onChange={(event) => setSourceInput(event.target.value)}
            />
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => void handlePreview("project")} type="button">
                Preview in Workspace
              </Button>
              <Button variant="outline" size="sm" onClick={() => void handlePreview("global")} type="button">
                Preview in Library
              </Button>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" disabled={mutationBlocked} onClick={() => void handleInstall("project")} type="button">
                Install to Workspace
              </Button>
              <Button size="sm" variant="secondary" disabled={mutationBlocked} onClick={() => void handleInstall("global")} type="button">
                Install to Cowork Library
              </Button>
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
          </CardContent>
        </Card>

        <div className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Effective at runtime
        </div>
        <div className="mb-4 space-y-1">
          {effectiveSkills.length === 0 ? (
            <div className="rounded-md border border-border/70 bg-muted/30 px-2 py-2 text-xs text-muted-foreground">
              {rt?.skillCatalogLoading ? "Loading effective skills..." : "No effective skills."}
            </div>
          ) : (
            effectiveSkills.map((installation) => (
              <Button
                key={`effective:${installation.installationId}`}
                variant={installation.installationId === rt?.selectedSkillInstallationId ? "secondary" : "ghost"}
                className="h-auto w-full justify-start px-3 py-2 text-left"
                onClick={() => void selectSkillInstallation(installation.installationId)}
                type="button"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate font-semibold text-sm">{installation.interface?.displayName || installation.name}</div>
                  <div className="truncate text-xs text-muted-foreground">{scopeLabel(installation.scope)}</div>
                </div>
              </Button>
            ))
          )}
        </div>

        <div className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          All installations
        </div>
        {installations.length > 0 ? (
          <SortableInstallations
            installations={installations}
            selectedId={rt?.selectedSkillInstallationId ?? null}
            onSelect={(installationId) => void selectSkillInstallation(installationId)}
          />
        ) : (
          <div className="rounded-md border border-border/70 bg-muted/30 px-2 py-2 text-xs text-muted-foreground">
            {rt?.skillCatalogLoading ? "Loading installations..." : "No installed skills found."}
          </div>
        )}
      </aside>

      <main className="min-h-0 overflow-auto p-4">
        <div className="mx-auto flex max-w-6xl flex-col gap-4">
          {rt?.selectedSkillPreview ? (
            <Card className="border-border/80 bg-card/80">
              <CardHeader>
                <CardTitle className="text-lg">Install preview</CardTitle>
                <CardDescription>
                  {rt.selectedSkillPreview.source.displaySource} → {scopeLabel(rt.selectedSkillPreview.targetScope)}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {rt.selectedSkillPreview.warnings.length > 0 ? (
                  <div className="space-y-2">
                    {rt.selectedSkillPreview.warnings.map((warning) => (
                      <div key={warning} className="rounded-md border border-border/70 bg-muted/25 px-3 py-2 text-sm text-muted-foreground">
                        {warning}
                      </div>
                    ))}
                  </div>
                ) : null}
                <div className="space-y-2">
                  {rt.selectedSkillPreview.candidates.map((candidate) => (
                    <div key={`${candidate.name}:${candidate.relativeRootPath}`} className="rounded-lg border border-border/70 px-3 py-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="font-semibold">{candidate.name}</div>
                        <Badge variant={candidate.wouldBeEffective ? "default" : "secondary"}>
                          {candidate.wouldBeEffective ? "Would be effective" : "Would be shadowed"}
                        </Badge>
                        {candidate.conflictsWithInstallationId ? (
                          <Badge variant="outline">Replaces {candidate.conflictsWithScope}</Badge>
                        ) : null}
                      </div>
                      <div className="mt-1 text-sm text-muted-foreground">{candidate.description}</div>
                      <div className="mt-1 text-xs text-muted-foreground">{candidate.relativeRootPath}</div>
                      {candidate.diagnostics.length > 0 ? (
                        <div className="mt-2 space-y-1">
                          {candidate.diagnostics.map((diagnostic) => (
                            <div key={`${candidate.name}:${diagnostic.code}`} className="text-xs text-destructive">
                              {diagnostic.message}
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          ) : null}

          {selectedInstallation ? (
            <Card className="border-border/80 bg-card/85">
              <CardHeader>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="space-y-2">
                    <CardTitle className="text-2xl tracking-tight">{selectedDisplayName}</CardTitle>
                    <CardDescription>{selectedDescription}</CardDescription>
                    <div className="flex flex-wrap gap-2">
                      <Badge variant={stateTone(selectedInstallation.state)}>{selectedInstallation.state}</Badge>
                      <Badge variant="secondary">{scopeLabel(selectedInstallation.scope)}</Badge>
                      <Badge variant="outline">{selectedInstallation.writable ? "Writable" : "Read-only"}</Badge>
                      {selectedInstallation.managed ? <Badge variant="outline">Managed</Badge> : <Badge variant="outline">Unmanaged</Badge>}
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <Button variant="outline" size="sm" onClick={() => void revealPath({ path: selectedInstallation.rootDir })} type="button">
                      Reveal
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => void openPath({ path: selectedInstallation.rootDir })} type="button">
                      Open
                    </Button>
                    {selectedInstallation.writable ? (
                      <>
                        {selectedInstallation.enabled ? (
                          <Button
                            variant="secondary"
                            size="sm"
                            disabled={mutationBlocked || actionPending(rt, "disable", selectedInstallation.installationId)}
                            onClick={() => void disableSkillInstallation(selectedInstallation.installationId)}
                            type="button"
                          >
                            Disable
                          </Button>
                        ) : (
                          <Button
                            variant="secondary"
                            size="sm"
                            disabled={mutationBlocked || actionPending(rt, "enable", selectedInstallation.installationId)}
                            onClick={() => void enableSkillInstallation(selectedInstallation.installationId)}
                            type="button"
                          >
                            Enable
                          </Button>
                        )}
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={mutationBlocked}
                          onClick={() => void checkSkillInstallationUpdate(selectedInstallation.installationId)}
                          type="button"
                        >
                          Check update
                        </Button>
                        <Button
                          size="sm"
                          disabled={mutationBlocked || !updateCheck?.canUpdate || actionPending(rt, "update", selectedInstallation.installationId)}
                          onClick={() => void updateSkillInstallation(selectedInstallation.installationId)}
                          type="button"
                        >
                          Update
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={mutationBlocked || actionPending(rt, "delete", selectedInstallation.installationId)}
                          onClick={() => void deleteSkillInstallation(selectedInstallation.installationId)}
                          type="button"
                        >
                          Delete
                        </Button>
                      </>
                    ) : (
                      <>
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={mutationBlocked}
                          onClick={() => void copySkillInstallation(selectedInstallation.installationId, "project")}
                          type="button"
                        >
                          Copy to Workspace
                        </Button>
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={mutationBlocked}
                          onClick={() => void copySkillInstallation(selectedInstallation.installationId, "global")}
                          type="button"
                        >
                          Copy to Library
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="rounded-lg border border-border/70 p-3">
                    <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Path & precedence</div>
                    <div className="space-y-2 text-sm">
                      <div><span className="font-medium">Root:</span> {selectedInstallation.rootDir}</div>
                      {selectedInstallation.shadowedByInstallationId ? (
                        <div>
                          <span className="font-medium">Shadowed by:</span> {selectedInstallation.shadowedByScope} / {selectedInstallation.shadowedByInstallationId}
                        </div>
                      ) : null}
                      {selectedInstallation.updatedAt ? <div><span className="font-medium">Updated:</span> {selectedInstallation.updatedAt}</div> : null}
                    </div>
                  </div>
                  <div className="rounded-lg border border-border/70 p-3">
                    <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Origin & diagnostics</div>
                    <div className="space-y-2 text-sm">
                      <div><span className="font-medium">Origin:</span> {selectedInstallation.origin?.kind || "unknown"}</div>
                      {selectedInstallation.origin?.url ? <div><span className="font-medium">URL:</span> {selectedInstallation.origin.url}</div> : null}
                      {selectedInstallation.diagnostics.length > 0 ? (
                        selectedInstallation.diagnostics.map((diagnostic) => (
                          <div key={diagnostic.code} className="text-destructive">
                            {diagnostic.message}
                          </div>
                        ))
                      ) : (
                        <div className="text-muted-foreground">No diagnostics.</div>
                      )}
                    </div>
                  </div>
                </div>

                {updateCheck && !updateCheck.canUpdate ? (
                  <div className="rounded-md border border-border/70 bg-muted/25 px-3 py-2 text-sm text-muted-foreground">
                    {updateCheck.reason}
                  </div>
                ) : null}

                {safeContent ? (
                  <div className="rounded-lg border border-border/70 p-4">
                    <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Documentation</div>
                    <Streamdown className="max-w-none text-sm leading-7 [&>*:first-child]:mt-0 [&_a]:underline [&_code]:rounded-sm [&_code]:bg-muted/45 [&_code]:px-1.5 [&_code]:py-0.5 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:border-border/80 [&_pre]:bg-muted/35 [&_pre]:p-3">
                      {safeContent}
                    </Streamdown>
                  </div>
                ) : (
                  <div className="rounded-lg border border-border/70 px-4 py-6 text-sm text-muted-foreground">
                    {selectedInstallation.skillPath ? "Loading skill documentation..." : "This installation does not have readable skill content."}
                  </div>
                )}
              </CardContent>
            </Card>
          ) : selectedSkillName ? (
            <Card className="border-border/80 bg-card/85">
              <CardHeader>
                <CardTitle className="text-2xl tracking-tight">{selectedDisplayName}</CardTitle>
                <CardDescription>{selectedDescription}</CardDescription>
                {selectedSkill ? <Badge variant="secondary" className="w-fit">{skillSourceLabel(selectedSkill.source)}</Badge> : null}
              </CardHeader>
              <CardContent className="min-h-0 flex-1 overflow-auto">
                {safeContent ? (
                  <Streamdown className="max-w-none text-sm leading-7 [&>*:first-child]:mt-0 [&_a]:underline [&_code]:rounded-sm [&_code]:bg-muted/45 [&_code]:px-1.5 [&_code]:py-0.5 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:border-border/80 [&_pre]:bg-muted/35 [&_pre]:p-3">
                    {safeContent}
                  </Streamdown>
                ) : (
                  <div className="text-sm text-muted-foreground">Loading...</div>
                )}
              </CardContent>
            </Card>
          ) : (
            <div className="flex h-full items-center justify-center rounded-xl border border-dashed border-border/70 bg-muted/25">
              <div className="text-center">
                <div className="text-lg font-semibold">Select a skill installation</div>
                <div className="text-sm text-muted-foreground">
                  Browse the effective runtime skills and every installed copy on disk.
                </div>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
