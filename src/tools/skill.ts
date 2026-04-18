import fs from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { discoverSkillsForConfig, stripSkillFrontMatter } from "../skills";
import { resolveWorkspaceFeatureFlags } from "../shared/featureFlags";
import type { ToolContext } from "./context";
import { defineTool } from "./defineTool";

type SkillCacheEntry = {
  content: string;
  mtimeMs: number;
  size: number;
};

const loadedSkills = new Map<string, SkillCacheEntry>();
const SKILL_POLICY_OVERLAYS: Record<string, string> = {
  slides: [
    "## Cowork Addendum",
    "",
    "- Keep slide task folders clean. For one-off deck work, do not create `package.json`, lockfiles, or `node_modules` in the user's deck/output folder just to run PptxGenJS.",
    "- If JavaScript dependencies are truly unavoidable, stage them outside the user's requested workspace/output folder (for example a shared Cowork cache) instead of next to the deliverable.",
    "- The deliverable folder should usually contain only the `.pptx`, the authoring `.js`, copied helper/assets that are actually needed, and review outputs the user asked to keep.",
  ].join("\n"),
};

async function readIfExists(p: string): Promise<string | null> {
  try {
    const stat = await fs.stat(p);
    if (!stat.isFile()) return null;

    const cacheKey = path.resolve(p);
    const cached = loadedSkills.get(cacheKey);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.content;
    }

    const content = await fs.readFile(p, "utf-8");
    loadedSkills.set(cacheKey, { content, mtimeMs: stat.mtimeMs, size: stat.size });
    return content;
  } catch {
    return null;
  }
}

export function createSkillTool(ctx: ToolContext) {
  const a2uiEnabled =
    ctx.config.featureFlags?.workspace !== undefined
      ? resolveWorkspaceFeatureFlags(ctx.config.featureFlags.workspace).a2ui
      : (ctx.config.enableA2ui ?? false);
  const skills = (ctx.availableSkills ?? []).filter((skill) => a2uiEnabled || skill.name !== "a2ui");
  const searchOrder = [
    "project",
    "global (~/.cowork/skills)",
    "user (~/.agent/skills)",
    ...(ctx.config.skillsDirs.length >= 4 ? ["built-in"] : []),
  ].join(", ");

  // Build description dynamically from discovered skills so models see actual skill names.
  let description =
    "Load a skill (a SKILL.md file) to get specialized instructions for producing a specific type of deliverable.\n\n" +
    "IMPORTANT: Always call this tool BEFORE creating any deliverable. Do NOT skip this step.\n" +
    `Skills are searched in ${searchOrder} directories.`;

  let paramDesc: string;
  if (skills.length > 0) {
    const skillList = skills.map((s) => `- "${s.name}": ${s.description}`).join("\n");
    description += `\n\nAvailable skills:\n${skillList}`;
    const names = skills.map((s) => `'${s.name}'`).join(", ");
    paramDesc = `The skill to load. Available: ${names}`;
  } else {
    paramDesc = "The skill to load (use the exact name from the Available Skills section of the system prompt)";
  }

  return defineTool({
    description,
    inputSchema: z.object({
      skillName: z.string().describe(paramDesc),
    }),
    execute: async ({ skillName }: { skillName: string }) => {
      ctx.log(`tool> skill ${JSON.stringify({ skillName })}`);
      if (!a2uiEnabled && skillName === "a2ui") {
        ctx.log(`tool< skill ${JSON.stringify({ ok: false, reason: "feature_disabled" })}`);
        return `Skill "${skillName}" not found.`;
      }
      const discovered = await discoverSkillsForConfig(ctx.config);
      const selected = discovered.find((s) => s.enabled && s.name === skillName);
      if (!selected) {
        ctx.log(`tool< skill ${JSON.stringify({ ok: false, reason: "not_found" })}`);
        return `Skill "${skillName}" not found.`;
      }

      const content = await readIfExists(path.resolve(selected.path));
      if (!content) {
        ctx.log(`tool< skill ${JSON.stringify({ ok: false, reason: "read_error" })}`);
        return `Skill "${skillName}" not found.`;
      }
      ctx.log(`tool< skill ${JSON.stringify({ ok: true })}`);

      const body = stripSkillFrontMatter(content);
      const overlay = SKILL_POLICY_OVERLAYS[skillName];
      if (!overlay) return body;

      return `${body}\n\n${overlay}`;
    },
  });
}
