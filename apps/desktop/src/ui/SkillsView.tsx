import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import { useEffect, useMemo, useState } from "react";

import { useAppStore } from "../app/store";
import type { SkillEntry } from "../lib/wsProtocol";

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
  // Defensive: older servers may send SKILL.md with YAML front matter intact.
  // Tolerate optional UTF-8 BOM.
  const re = /^\ufeff?---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/;
  return raw.replace(re, "").trimStart();
}

export function SkillsView() {
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const workspaces = useAppStore((s) => s.workspaces);
  const wsRtById = useAppStore((s) => s.workspaceRuntimeById);
  const openSkills = useAppStore((s) => s.openSkills);
  const restartWorkspaceServer = useAppStore((s) => s.restartWorkspaceServer);
  const selectSkill = useAppStore((s) => s.selectSkill);
  const disableSkill = useAppStore((s) => s.disableSkill);
  const enableSkill = useAppStore((s) => s.enableSkill);
  const deleteSkill = useAppStore((s) => s.deleteSkill);

  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    skill: SkillEntry;
    displayName: string;
  } | null>(null);

  useEffect(() => {
    if (!ctxMenu) return;
    const onClick = () => setCtxMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCtxMenu(null);
    };
    window.addEventListener("click", onClick);
    window.addEventListener("blur", onClick);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", onClick);
      window.removeEventListener("blur", onClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [ctxMenu]);

  if (!selectedWorkspaceId) {
    return (
      <div className="hero">
        <div className="heroTitle">Pick a workspace</div>
        <div className="heroSub">Select a workspace to view available skills.</div>
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
  const selectedShortDescription =
    selectedSkill?.interface?.shortDescription || selectedSkill?.description || "Open `SKILL.md` to see triggers and workflow instructions.";
  const selectedIcon = selectedSkill?.interface?.iconLarge || selectedSkill?.interface?.iconSmall || null;
  const safeContent = content ? stripYamlFrontMatter(content) : null;

  const selectedSourceLabel = selectedSkill ? skillSourceLabel(selectedSkill.source) : null;

  const ctxStyle = useMemo(() => {
    if (!ctxMenu) return null;
    const w = 220;
    const h = 140;
    const left = Math.max(10, Math.min(ctxMenu.x, window.innerWidth - w - 10));
    const top = Math.max(10, Math.min(ctxMenu.y, window.innerHeight - h - 10));
    return { left, top } as const;
  }, [ctxMenu]);

  return (
    <div className="skillsLayout">
      <div className="skillsList">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 10, marginBottom: 10 }}>
          <button
            className="iconButton"
            type="button"
            onClick={async () => {
              const ok = window.confirm("Restart workspace server? This will disconnect any open threads.");
              if (!ok) return;
              await restartWorkspaceServer(selectedWorkspaceId);
              await openSkills();
            }}
            title="Restart workspace server (disconnects threads)"
          >
            Restart
          </button>
        </div>

        {skills.length === 0 && !rt?.controlSessionId ? (
          <div style={{ color: "rgba(0,0,0,0.5)" }}>Loading skills…</div>
        ) : null}

        {skills.length === 0 && rt?.controlSessionId ? (
          <div style={{ color: "rgba(0,0,0,0.5)" }}>
            No skills discovered yet. The agent searches:
            <div style={{ marginTop: 8, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace", fontSize: 12 }}>
              <div>{ws?.path}/.agent/skills</div>
              <div>~/.cowork/skills</div>
              <div>~/.agent/skills</div>
              <div>(built-in)</div>
            </div>
          </div>
        ) : null}

        {skills.map((s) => {
          const active = s.name === selectedSkillName;
          const icon = s.interface?.iconSmall || s.interface?.iconLarge || null;
          const displayName = s.interface?.displayName || s.name;
          const desc = s.interface?.shortDescription || s.description;
          return (
            <div
              key={s.name}
              className={"skillsItem" + (active ? " skillsItemActive" : "") + (!s.enabled ? " skillsItemDisabled" : "")}
              onClick={() => void selectSkill(s.name)}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setCtxMenu({ x: e.clientX, y: e.clientY, skill: s, displayName });
              }}
            >
              <div className="skillsItemRow">
                <div className="skillsIcon">
                  {icon ? <img src={icon} alt="" /> : <div className="skillsIconPlaceholder" />}
                </div>
                <div className="skillsMeta">
                  <div className="skillsNameRow">
                    <div className="skillsName">{displayName}</div>
                    <div className="skillsBadges">
                      <div className="skillsBadge" title={s.path}>
                        {skillSourceLabel(s.source)}
                      </div>
                      {!s.enabled ? <div className="skillsBadge skillsBadgeDisabled">Disabled</div> : null}
                    </div>
                  </div>
                  <div className="skillsDesc">{desc}</div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="skillsContent">
        {selectedSkillName ? (
          <>
            <div className="skillHeader">
              <div className="skillHeaderTop">
                <div className="skillHeaderIcon">
                  {selectedIcon ? <img src={selectedIcon} alt="" /> : <div className="skillsIconPlaceholder" />}
                </div>
                <div className="skillHeaderText">
                  <div className="skillHeaderTitle">{selectedDisplayName}</div>
                  <div className="skillHeaderSub">{selectedShortDescription}</div>
                </div>
              </div>

              <div className="skillChips">
                {ws?.name ? <span className="chip">{ws.name}</span> : null}
                {selectedSourceLabel ? (
                  <span className="chip chipQuiet" title={selectedSkill?.path}>
                    {selectedSourceLabel}
                  </span>
                ) : null}
                {(selectedSkill?.interface?.agents ?? []).map((a) => (
                  <span key={a} className="chip">
                    {a}
                  </span>
                ))}
                {(selectedSkill?.triggers ?? []).slice(0, 8).map((t) => (
                  <span key={t} className="chip chipQuiet">
                    {t}
                  </span>
                ))}
              </div>

              {selectedSkill?.interface?.defaultPrompt ? (
                <div className="skillPrompt">
                  <div className="skillPromptLabel">Default prompt</div>
                  <div className="skillPromptText">{selectedSkill.interface.defaultPrompt}</div>
                </div>
              ) : null}
            </div>

            <div className="skillsDocScroll">
              {safeContent ? (
                <div className="markdown">
                  <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
                    {safeContent}
                  </ReactMarkdown>
                </div>
              ) : (
                <div style={{ color: "rgba(0,0,0,0.55)" }}>Loading…</div>
              )}
            </div>
          </>
        ) : (
          <div className="hero" style={{ height: "auto", paddingTop: 40 }}>
            <div className="heroTitle" style={{ fontSize: 22 }}>
              Select a skill
            </div>
            <div className="heroSub" style={{ fontSize: 15 }}>
              Open `SKILL.md` to see triggers and workflow instructions.
            </div>
          </div>
        )}
      </div>

      {ctxMenu && ctxStyle ? (
        <div className="ctxMenu" style={ctxStyle} onClick={(e) => e.stopPropagation()}>
          <div className="ctxMenuTitle">{ctxMenu.displayName}</div>

          {ctxMenu.skill.source === "global" ? (
            <>
              {ctxMenu.skill.enabled ? (
                <button
                  className="ctxMenuItem"
                  type="button"
                  onClick={() => {
                    void disableSkill(ctxMenu.skill.name);
                    setCtxMenu(null);
                  }}
                >
                  Disable (move to ~/.cowork/disabled-skills)
                </button>
              ) : (
                <button
                  className="ctxMenuItem"
                  type="button"
                  onClick={() => {
                    void enableSkill(ctxMenu.skill.name);
                    setCtxMenu(null);
                  }}
                >
                  Enable (move back to ~/.cowork/skills)
                </button>
              )}

              <button
                className="ctxMenuItem ctxMenuItemDanger"
                type="button"
                onClick={() => {
                  const ok = window.confirm(`Delete skill "${ctxMenu.skill.name}"? This cannot be undone.`);
                  if (!ok) return;
                  void deleteSkill(ctxMenu.skill.name);
                  setCtxMenu(null);
                }}
              >
                Delete (permanently)
              </button>
            </>
          ) : (
            <div className="ctxMenuMuted">Enable/disable and delete are only supported for global skills in v1.</div>
          )}
        </div>
      ) : null}
    </div>
  );
}
