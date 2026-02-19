import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";

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
  const selectedDescription = selectedSkill?.interface?.shortDescription || selectedSkill?.description || "";
  const safeContent = content ? stripYamlFrontMatter(content) : null;

  return (
    <div className="skillsLayout">
      <div className="skillsList">
        {skills.length === 0 && !rt?.controlSessionId ? (
          <div style={{ color: "var(--muted)" }}>Loading skills…</div>
        ) : skills.length === 0 && rt?.controlSessionId ? (
          <div style={{ color: "var(--muted)" }}>No skills found.</div>
        ) : (
          skills.map((s) => {
            const active = s.name === selectedSkillName;
            const displayName = s.interface?.displayName || s.name;
            const desc = s.interface?.shortDescription || s.description;

            return (
              <button
                key={s.name}
                className={"skillsItem" + (active ? "" : "")}
                data-active={active}
                type="button"
                aria-pressed={active}
                onClick={() => void selectSkill(s.name)}
              >
                <div className="skillsName">{displayName}</div>
                <div className="skillsDesc">{desc}</div>
              </button>
            );
          })
        )}
      </div>

      <div className="skillsContent">
        {selectedSkillName ? (
          <>
            <div className="skillsHeader">
              <div className="skillsHeaderTitle">{selectedDisplayName}</div>
              <div className="skillsHeaderSub">{selectedDescription}</div>
              {selectedSkill && (
                <div style={{ marginTop: 8 }}>
                  <span className="pill">{skillSourceLabel(selectedSkill.source)}</span>
                </div>
              )}
            </div>

            <div className="skillsDoc">
              {safeContent ? (
                <div className="markdown">
                  <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
                    {safeContent}
                  </ReactMarkdown>
                </div>
              ) : (
                <div style={{ color: "var(--muted)" }}>Loading…</div>
              )}
            </div>
          </>
        ) : (
          <div className="hero" style={{ height: "auto", paddingTop: 40 }}>
            <div className="heroTitle" style={{ fontSize: 18 }}>Select a skill</div>
            <div className="heroSub" style={{ fontSize: 14 }}>Select a skill to view its documentation.</div>
          </div>
        )}
      </div>
    </div>
  );
}
