import fs from "node:fs/promises";
import path from "node:path";

import type { AgentConfig } from "./types";
import { discoverSkills } from "./skills";
import { assertSupportedModel, type SupportedModel } from "./models/registry";

async function resolveSystemTemplatePath(config: AgentConfig): Promise<string> {
  const supportedModel = assertSupportedModel(config.provider, config.model, "model");
  const modelSystemPath = path.join(config.builtInDir, "prompts", supportedModel.promptTemplate);
  try {
    await fs.access(modelSystemPath);
    return modelSystemPath;
  } catch {
    return path.join(config.builtInDir, "prompts", "system.md");
  }
}

function stripPromptLine(prompt: string, matcher: RegExp): string {
  return prompt
    .split("\n")
    .filter((line) => !matcher.test(line))
    .join("\n");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function renderTemplateVariables(prompt: string, vars: Record<string, string>): string {
  let out = prompt;

  for (const [key, value] of Object.entries(vars)) {
    if (value.trim().length > 0) continue;
    const lineRegex = new RegExp(`^.*\\{\\{${escapeRegExp(key)}\\}\\}.*(?:\\r?\\n|$)`, "gm");
    out = out.replace(lineRegex, "");
  }

  return out.replace(/\{\{([A-Za-z0-9_]+)\}\}/g, (match, key: string) => vars[key] ?? match);
}

function renderCapabilitySpecificPrompt(prompt: string, supportedModel: SupportedModel): string {
  if (supportedModel.supportsImageInput) return prompt;

  let out = prompt;
  const replacements: Array<[RegExp, string]> = [
    [/(text,\s*CSV,\s*)images(,\s*PDFs)/gi, "$1PDFs"],
    [/(text,\s*images,\s*and\s*)PDFs/gi, "text and PDFs"],
    [/(text files,\s*)images\s*\(returned as visual content if the model supports it\),\s*and\s*PDFs/gi, "text files and PDFs"],
    [/(Supports\s*)text,\s*images,\s*and\s*PDFs/gi, "$1text and PDFs"],
    [/(supports\s*)text files,\s*images\s*\(visual content\),\s*and\s*PDFs/gi, "$1text files and PDFs"],
    [/(creating a PDF from uploaded )images/gi, "$1files"],
  ];

  for (const [pattern, replacement] of replacements) {
    out = out.replace(pattern, replacement);
  }

  // Keep these patterns aligned with prompt template wording; non-image models still
  // rely on stripping matching guidance lines rather than template conditionals here.
  const imageGuidancePatterns = [
    /visual content for supported images/i,
    /if read returns an image/i,
    /do not ask the user to re-upload it just because it is visual/i,
    /url points directly to an image/i,
    /download a direct image url and inspect it with `read`/i,
    /downloaded path to inspect it visually/i,
    /uploads an image of text/i,
    /images might require both the pdf skill and an image processing skill/i,
  ];

  for (const pattern of imageGuidancePatterns) {
    out = stripPromptLine(out, pattern);
  }

  return out;
}

function buildSkillSearchOrder(config: AgentConfig): string {
  const labels = ["project", "global (~/.cowork/skills)", "user (~/.agent/skills)", "built-in"];
  return config.skillsDirs
    .map((_, index) => labels[index] ?? `skills-dir-${index + 1}`)
    .join(" -> ");
}

function buildSkillPolicySection(skillNames: string, skillExamples: string, config: AgentConfig): string {
  return [
    "## Skill Loading Policy (Strict)",
    "",
    "- Before creating any domain deliverable (spreadsheet, document, slides, PDF), call the `skill` tool first.",
    "- If the user prompt explicitly says to use the `skill` tool, that call is mandatory and must happen before related artifact creation.",
    "- Do not write build scripts or output artifacts for those domains before loading the corresponding skill.",
    "- If the task spans multiple deliverable domains, load each required skill before creating files.",
    "- Never claim a skill was loaded unless the `skill` tool call actually occurred in this run.",
    "- For one-off deliverables, keep the user's workspace focused on the requested artifacts and source files instead of scaffolding a disposable package-managed project.",
    "- Do not create `package.json`, `package-lock.json`, `bun.lock`, `yarn.lock`, `pnpm-lock.yaml`, or `node_modules` in the user's deliverable folder unless the user explicitly asked for a reusable Node project or that folder is already an existing package-managed project.",
    "- If extra JavaScript dependencies are genuinely unavoidable, stage them outside the user's deliverable folder (for example a shared Cowork cache) instead of next to the files the user asked for.",
    `- Canonical skill names available in this run: ${skillNames}.`,
    `- Active skill search order for this run: ${buildSkillSearchOrder(config)}.`,
    "",
    "Examples:",
    skillExamples,
  ].join("\n");
}

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
  const supportedModel = assertSupportedModel(config.provider, config.model, "model");
  const systemPath = await resolveSystemTemplatePath(config);
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
    currentDate: new Date().toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    }),
    currentYear: new Date().getFullYear().toString(),
    modelName: supportedModel.displayName,
    userName: config.userName || "",
    userProfileInstructions: config.userProfile?.instructions || "",
    userProfileWork: config.userProfile?.work || "",
    userProfileDetails: config.userProfile?.details || "",
    knowledgeCutoff: supportedModel.knowledgeCutoff,
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

  prompt = renderTemplateVariables(prompt, vars);
  prompt = renderCapabilitySpecificPrompt(prompt, supportedModel);

  prompt += `\n\n${buildSkillPolicySection(vars.skillNames, vars.skillExamples, config)}`;

  if (skills.length > 0) {
    const list = skills
      .map(
        (s) =>
          `- **${s.name}**: ${s.description} (location: ${s.path}; source: ${s.source}; triggers: ${s.triggers.join(", ")})`
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
