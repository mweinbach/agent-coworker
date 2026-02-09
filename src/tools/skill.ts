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
  return tool({
    description: `Load a skill (a SKILL.md file) to get specialized instructions.

Use this before producing deliverables like spreadsheets, slides, PDFs, or Word docs.
Skills are searched in project, global (~/.cowork/skills), user (~/.agent/skills), then built-in directories.`,
    inputSchema: z.object({
      skillName: z.string().describe("The skill to load (e.g. 'xlsx', 'pptx', 'pdf', 'docx')"),
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
