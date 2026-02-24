import fs from "node:fs/promises";
import path from "node:path";

import { tool } from "ai";
import { z } from "zod";

import { discoverSkills, stripSkillFrontMatter } from "../skills";
import type { ToolContext } from "./context";

type SkillCacheEntry = {
  content: string;
  mtimeMs: number;
  size: number;
};

const loadedSkills = new Map<string, SkillCacheEntry>();

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
  const skills = ctx.availableSkills ?? [];

  // Build description dynamically from discovered skills so models see actual skill names.
  let description =
    "Load a skill (a SKILL.md file) to get specialized instructions for producing a specific type of deliverable.\n\n" +
    "IMPORTANT: Always call this tool BEFORE creating any deliverable. Do NOT skip this step.\n" +
    "Skills are searched in project, global (~/.cowork/skills), user (~/.agent/skills), then built-in directories.";

  let paramDesc: string;
  if (skills.length > 0) {
    const skillList = skills.map((s) => `- "${s.name}": ${s.description}`).join("\n");
    description += `\n\nAvailable skills:\n${skillList}`;
    const names = skills.map((s) => `'${s.name}'`).join(", ");
    paramDesc = `The skill to load. Available: ${names}`;
  } else {
    paramDesc = "The skill to load (use the exact name from the Available Skills section of the system prompt)";
  }

  return tool({
    description,
    inputSchema: z.object({
      skillName: z.string().describe(paramDesc),
    }),
    execute: async ({ skillName }) => {
      ctx.log(`tool> skill ${JSON.stringify({ skillName })}`);
      const discovered = await discoverSkills(ctx.config.skillsDirs);
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
      return stripSkillFrontMatter(content);
    },
  });
}
