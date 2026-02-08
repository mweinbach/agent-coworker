import fs from "node:fs/promises";
import path from "node:path";

import type { AgentConfig } from "./types";
import { discoverSkills } from "./skills";

async function loadHotCache(config: AgentConfig): Promise<string> {
  const candidates = [
    path.join(config.projectAgentDir, "AGENT.md"),
    path.join(config.userAgentDir, "AGENT.md"),
  ];

  for (const p of candidates) {
    try {
      return await fs.readFile(p, "utf-8");
    } catch {
      // ignore
    }
  }
  return "";
}

export async function loadSystemPrompt(config: AgentConfig): Promise<string> {
  const systemPath = path.join(config.builtInDir, "prompts", "system.md");
  let prompt = await fs.readFile(systemPath, "utf-8");

  const vars: Record<string, string> = {
    workingDirectory: config.workingDirectory,
    outputDirectory: config.outputDirectory,
    uploadsDirectory: config.uploadsDirectory,
    currentDate: new Date().toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    }),
    currentYear: new Date().getFullYear().toString(),
    modelName: config.model,
    userName: config.userName || "",
    knowledgeCutoff: config.knowledgeCutoff || "unknown",
    skillsDirectory: config.skillsDirs[0] || path.join(config.projectAgentDir, "skills"),
  };

  for (const [k, v] of Object.entries(vars)) {
    prompt = prompt.replaceAll(`{{${k}}}`, v);
  }

  const skills = await discoverSkills(config.skillsDirs);
  if (skills.length > 0) {
    const list = skills
      .map(
        (s) =>
          `- **${s.name}**: ${s.description} (source: ${s.source}; triggers: ${s.triggers.join(", ")})`
      )
      .join("\n");
    prompt +=
      "\n\n## Available Skills\n\nLoad these with the skill tool before creating the relevant output:\n\n" +
      list;
  }

  const hotCache = await loadHotCache(config);
  if (hotCache.trim()) {
    prompt += `\n\n## Memory (loaded from previous sessions)\n\n${hotCache}`;
  }

  return prompt;
}

export async function loadSubAgentPrompt(
  config: AgentConfig,
  agentType: "explore" | "research" | "general"
): Promise<string> {
  const p = path.join(config.builtInDir, "prompts", "sub-agents", `${agentType}.md`);
  return fs.readFile(p, "utf-8");
}
