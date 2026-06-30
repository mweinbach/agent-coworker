import { z } from "zod";

import { loadSkillBodyByName } from "../skills/loadSkillBody";
import type { ToolContext } from "./context";
import { defineTool } from "./defineTool";

export function createSkillTool(ctx: ToolContext) {
  const allowedSkillNames = ctx.agentProfile ? new Set(ctx.agentProfile.skillNames) : null;
  const skills = (ctx.availableSkills ?? []).filter(
    (skill) => !allowedSkillNames || allowedSkillNames.has(skill.name),
  );
  const searchOrder = [
    "project",
    "global (~/.cowork/skills)",
    ...(ctx.config.skillsDirs.length >= 3 ? ["built-in"] : []),
  ].join(", ");

  // Build description dynamically from discovered skills so models see actual skill names.
  let description =
    "Load a skill (a SKILL.md file) to get specialized instructions for producing a specific type of deliverable.\n\n" +
    "IMPORTANT: When a relevant skill is listed below, call this tool BEFORE creating that deliverable. " +
    "If no listed skill matches, continue without this tool; never invent a skill name or guess a SKILL.md path.\n" +
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
      if (allowedSkillNames && !allowedSkillNames.has(skillName)) {
        ctx.log(`tool< skill ${JSON.stringify({ ok: false, reason: "profile_blocked" })}`);
        return `Skill "${skillName}" is not available to this subagent profile.`;
      }

      const loaded = await loadSkillBodyByName(ctx.config, skillName);
      if (!loaded) {
        ctx.log(`tool< skill ${JSON.stringify({ ok: false, reason: "not_found" })}`);
        const available = skills.map((skill) => `"${skill.name}"`).join(", ");
        return available
          ? `Skill "${skillName}" not found. Available skills: ${available}. Use one only when it matches the task; otherwise continue without a skill. Do not guess a SKILL.md path.`
          : `Skill "${skillName}" not found. No skills are currently available. Continue without a skill and do not guess a SKILL.md path.`;
      }

      ctx.log(`tool< skill ${JSON.stringify({ ok: true })}`);
      return loaded.body;
    },
  });
}
