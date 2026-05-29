import { z } from "zod";

import { resolveExperimentalA2uiConfig } from "../experimental/a2ui/flags";
import { loadSkillBodyByName } from "../skills/loadSkillBody";
import type { ToolContext } from "./context";
import { defineTool } from "./defineTool";

export function createSkillTool(ctx: ToolContext) {
  const a2uiEnabled = resolveExperimentalA2uiConfig(ctx.config);
  const skills = (ctx.availableSkills ?? []).filter(
    (skill) => a2uiEnabled || skill.name !== "a2ui",
  );
  const searchOrder = [
    "project",
    "global (~/.cowork/skills)",
    ...(ctx.config.skillsDirs.length >= 3 ? ["built-in"] : []),
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
    paramDesc =
      "The skill to load (use the exact name from the Available Skills section of the system prompt)";
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

      const loaded = await loadSkillBodyByName(ctx.config, skillName);
      if (!loaded) {
        ctx.log(`tool< skill ${JSON.stringify({ ok: false, reason: "not_found" })}`);
        return `Skill "${skillName}" not found.`;
      }

      ctx.log(`tool< skill ${JSON.stringify({ ok: true })}`);
      return loaded.body;
    },
  });
}
