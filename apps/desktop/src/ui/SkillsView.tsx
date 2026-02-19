import { Streamdown } from "streamdown";

import { useAppStore } from "../app/store";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import type { SkillEntry } from "../lib/wsProtocol";
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

export function SkillsView() {
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const workspaces = useAppStore((s) => s.workspaces);
  const wsRtById = useAppStore((s) => s.workspaceRuntimeById);
  const selectSkill = useAppStore((s) => s.selectSkill);

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
  const skills = rt?.skills ?? [];
  const selectedSkillName = rt?.selectedSkillName ?? null;
  const content = rt?.selectedSkillContent ?? null;
  const selectedSkill = skills.find((s) => s.name === selectedSkillName) ?? null;
  const selectedDisplayName = selectedSkill?.interface?.displayName || selectedSkill?.name || selectedSkillName || "";
  const selectedDescription = selectedSkill?.interface?.shortDescription || selectedSkill?.description || "";
  const safeContent = content ? stripYamlFrontMatter(content) : null;

  return (
    <div className="grid h-full min-h-0 grid-cols-[300px_minmax(0,1fr)] bg-panel max-[960px]:grid-cols-1">
      <aside className="min-h-0 overflow-auto border-r border-border/70 bg-sidebar p-3 max-[960px]:max-h-64 max-[960px]:border-r-0 max-[960px]:border-b">
        <div className="mb-3 px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {ws?.name || "Skills"}
        </div>
        <div className="space-y-1">
          {skills.length === 0 && !rt?.controlSessionId ? (
            <div className="rounded-md border border-border/70 bg-muted/30 px-2 py-2 text-xs text-muted-foreground">Loading skills...</div>
          ) : skills.length === 0 && rt?.controlSessionId ? (
            <div className="rounded-md border border-border/70 bg-muted/30 px-2 py-2 text-xs text-muted-foreground">No skills found.</div>
          ) : (
            skills.map((skill) => {
              const active = skill.name === selectedSkillName;
              const displayName = skill.interface?.displayName || skill.name;
              const desc = skill.interface?.shortDescription || skill.description;

              return (
                <Button
                  key={skill.name}
                  variant={active ? "secondary" : "ghost"}
                  className={cn("h-auto w-full justify-start px-3 py-2 text-left", active ? "border border-border/70" : "")}
                  onClick={() => void selectSkill(skill.name)}
                  type="button"
                >
                  <div className="w-full">
                    <div className="truncate font-semibold text-sm">{displayName}</div>
                    <div className="line-clamp-2 text-xs text-muted-foreground">{desc}</div>
                  </div>
                </Button>
              );
            })
          )}
        </div>
      </aside>

      <main className="min-h-0 overflow-auto p-4">
        {selectedSkillName ? (
          <Card className="mx-auto flex h-full max-w-5xl flex-col border-border/80 bg-card/85">
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
              <div className="text-lg font-semibold">Select a skill</div>
              <div className="text-sm text-muted-foreground">Select a skill to view its documentation.</div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
