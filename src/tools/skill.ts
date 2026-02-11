import fs from "node:fs/promises";
import path from "node:path";

import { tool } from "ai";
import { z } from "zod";

import type { ToolContext } from "./context";

const loadedSkills = new Map<string, string>();

async function readIfExists(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, "utf-8");
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
      if (loadedSkills.has(skillName)) return loadedSkills.get(skillName)!;

      for (const dir of ctx.config.skillsDirs) {
        const p = path.join(dir, skillName, "SKILL.md");
        const content = await readIfExists(p);
        if (content) {
          loadedSkills.set(skillName, content);
          return content;
        }
      }

      // Fallback: flat file layout skills/<skillName>.md
      for (const dir of ctx.config.skillsDirs) {
        const p = path.join(dir, `${skillName}.md`);
        const content = await readIfExists(p);
        if (content) {
          loadedSkills.set(skillName, content);
          return content;
        }
      }

      return `Skill "${skillName}" not found.`;
    },
  });
}
