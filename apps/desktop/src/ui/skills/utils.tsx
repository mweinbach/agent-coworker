import type { useAppStore } from "../../app/store";
import type { SkillEntry, SkillInstallationEntry } from "../../lib/wsProtocol";

export function skillSourceLabel(source: SkillEntry["source"]): string {
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

export function stripYamlFrontMatter(raw: string): string {
  const re = /^\ufeff?---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/;
  return raw.replace(re, "").trimStart();
}

export function scopeLabel(scope: SkillInstallationEntry["scope"]): string {
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

export function stateTone(
  state: SkillInstallationEntry["state"],
): "default" | "secondary" | "outline" {
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

export function normalizeDisplayContent(raw: string | null): string | null {
  if (!raw) return null;
  return stripYamlFrontMatter(raw);
}

export function actionPending(
  rt: ReturnType<typeof useAppStore.getState>["workspaceRuntimeById"][string] | undefined,
  prefix: string,
  id?: string,
): boolean {
  if (!rt) return false;
  const key = id ? `${prefix}:${id}` : prefix;
  return rt.skillMutationPendingKeys[key] === true;
}

export function SkillIcon({ icon, className }: { icon: string; className?: string }) {
  if (icon.startsWith("data:") || icon.startsWith("http")) {
    return (
      <img
        src={icon}
        alt="Skill icon"
        className={`h-full w-full object-contain ${className || ""}`}
      />
    );
  }
  return <span className={className}>{icon}</span>;
}
