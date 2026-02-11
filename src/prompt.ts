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

/** Result of loading a system prompt, including discovered skill metadata for tool descriptions. */
export interface SystemPromptResult {
  prompt: string;
  discoveredSkills: Array<{ name: string; description: string }>;
}

/**
 * Load the system prompt and return both the prompt string and discovered skill metadata.
 * Use this when you need the skill metadata (e.g. for dynamic tool descriptions).
 */
export async function loadSystemPromptWithSkills(config: AgentConfig): Promise<SystemPromptResult> {
  const systemPath = path.join(config.builtInDir, "prompts", "system.md");
  let prompt = await fs.readFile(systemPath, "utf-8");

  const skills = await discoverSkills(config.skillsDirs);

  // Build dynamic skill-related template variables from discovered skills.
  let skillNames = "";
  let skillExamples = "";
  if (skills.length > 0) {
    skillNames = skills.map((s) => `"${s.name}"`).join(", ");
    skillExamples = skills
      .map((s) => {
        // Derive a natural activity from the skill description or name.
        const activity = s.description.split(".")[0] || s.name;
        return `- ${activity} → load the "${s.name}" skill before starting`;
      })
      .join("\n");
  }

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
    skillNames: skillNames || '"pdf", "doc", "slides", "spreadsheet"',
    skillExamples:
      skillExamples ||
      [
        "- Creating a presentation → load the \"slides\" skill before starting",
        "- Creating a spreadsheet → load the \"spreadsheet\" skill before starting",
        "- Creating a Word document → load the \"doc\" skill before starting",
        "- Creating a PDF → load the \"pdf\" skill before starting",
      ].join("\n"),
  };

  prompt = prompt.replace(/{{(\w+)}}/g, (match, key) => {
    return Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : match;
  });

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

  const discoveredSkills = skills.map((s) => ({ name: s.name, description: s.description }));
  return { prompt, discoveredSkills };
}

/**
 * Load the system prompt string. Backward-compatible wrapper around loadSystemPromptWithSkills.
 */
export async function loadSystemPrompt(config: AgentConfig): Promise<string> {
  const { prompt } = await loadSystemPromptWithSkills(config);
  return prompt;
}

export async function loadSubAgentPrompt(
  config: AgentConfig,
  agentType: "explore" | "research" | "general"
): Promise<string> {
  const p = path.join(config.builtInDir, "prompts", "sub-agents", `${agentType}.md`);
  return fs.readFile(p, "utf-8");
}
