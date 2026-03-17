import fs from "node:fs/promises";
import path from "node:path";

import type { AgentConfig } from "./types";
import { discoverSkills } from "./skills";
import { assertSupportedModel, defaultSupportedModel, type SupportedModel } from "./models/registry";
import { getChildAgentModelInfo, listChildAgentModelsWithInfo } from "./models/childAgentModelInfo";
import { parseChildModelRef } from "./models/childModelRouting";
import { MemoryStore } from "./memoryStore";
import { AGENT_ROLE_DEFINITIONS } from "./server/agents/roles";
import type { AgentRole } from "./shared/agents";
import { isUserFacingProviderEnabled } from "./providers/catalog";
import type { ProviderName } from "./types";

function resolvePromptModel(config: AgentConfig, modelId: string, source: string): SupportedModel {
  if (config.provider !== "openai-proxy") return assertSupportedModel(config.provider, modelId, source);
  const trimmed = modelId.trim();
  return { ...defaultSupportedModel("openai-proxy"), id: trimmed || defaultSupportedModel("openai-proxy").id, displayName: trimmed || "OpenAI-API Proxy" };
}

async function resolveSystemTemplatePath(config: AgentConfig): Promise<string> {
  const supportedModel = resolvePromptModel(config, config.model, "model");
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

function renderMemorySpecificPrompt(prompt: string, enabled: boolean): string {
  if (enabled) return prompt;

  let out = prompt;
  const memoryBlockPatterns = [
    /\n### memory\n[\s\S]*?(?=\n## [^\n]+\n|\n# [^\n]+\n|$)/i,
    /\n<tool name="memory">[\s\S]*?<\/tool>\n?/i,
    /\n<memory>[\s\S]*?<\/memory>\n?/i,
  ];

  for (const pattern of memoryBlockPatterns) {
    out = out.replace(pattern, "\n");
  }

  out = stripPromptLine(out, /^\s*-\s*Memory:\s*`?\.agent\/AGENT\.md/i);
  out = stripPromptLine(out, /^\s*Memory:\s*\.agent\/AGENT\.md/i);
  out = out.replace(/\n{3,}/g, "\n\n").trimEnd();

  return `${out}\n\n## Memory Disabled\n\nPersistent memory is disabled for this workspace. Do not read or write AGENT.md and do not call the memory tool.`;
}

const PROVIDER_DISPLAY_NAMES: Record<ProviderName, string> = {
  google: "Google",
  openai: "OpenAI",
  anthropic: "Anthropic",
  baseten: "Baseten",
  together: "Together AI",
  nvidia: "NVIDIA",
  "opencode-go": "OpenCode Go",
  "opencode-zen": "OpenCode Zen",
  "openai-proxy": "OpenAI-API Proxy",
  "codex-cli": "Codex CLI",
};

function buildSpawnAgentPromptBody(config: AgentConfig): string {
  const providerLabel = PROVIDER_DISPLAY_NAMES[config.provider] ?? config.provider;
  const currentModel = resolvePromptModel(config, config.model, "model");

  const roleLines = Object.values(AGENT_ROLE_DEFINITIONS)
    .map((role) => `- **${role.id}**: ${role.description}`)
    .join("\n");

  const crossProviderRefs = (config.allowedChildModelRefs ?? [])
    .map((ref) => {
      try {
        const parsed = parseChildModelRef(ref, config.provider, "child target");
        const supported = parsed.provider === "openai-proxy"
          ? { ...defaultSupportedModel("openai-proxy"), id: parsed.modelId, displayName: parsed.modelId }
          : assertSupportedModel(parsed.provider, parsed.modelId, "child target");
        const bestFor = getChildAgentModelInfo(parsed.provider, parsed.modelId)?.bestFor ?? "general-purpose work on this provider";
        const displayProvider = PROVIDER_DISPLAY_NAMES[parsed.provider] ?? parsed.provider;
        return `- **${displayProvider} / ${supported.displayName}** (\`${parsed.ref}\`): ${bestFor}.`;
      } catch {
        return null;
      }
    })
    .filter((line): line is string => Boolean(line));
  const providerSupportsUserFacingModels = isUserFacingProviderEnabled(config.provider);
  const modelLines = config.childModelRoutingMode === "cross-provider-allowlist" && crossProviderRefs.length > 0
    ? crossProviderRefs.join("\n")
    : !providerSupportsUserFacingModels
      ? "- No user-facing child model overrides are available for this provider."
      : listChildAgentModelsWithInfo(config.provider)
          .map((model) => `- **${model.displayName}** (\`${model.id}\`): ${model.bestFor ?? "general-purpose work on this provider"}.`)
          .join("\n");

  return [
    "Launch a collaborative child agent for a well-scoped task. It returns a durable child handle to use with follow-up agent tools; it does not return the child agent's final answer text directly.",
    "",
    "When to use:",
    "- **Parallelization**: Independent work that can proceed concurrently.",
    "- **Context isolation**: Large codebase reads, heavy research, or deep analysis that would bloat the parent context.",
    "- **Verification**: Focused review, testing, or validation after implementation.",
    "",
    "Rules:",
    "- Provide detailed, self-contained prompts with the exact files, ownership, and expected output.",
    "- If `model` is omitted, the child inherits the live parent provider/model.",
    "- `model` may be a same-provider model id or a full `provider:modelId` child target ref.",
    "- `preferredChildModelRef` is only a workspace/UI suggestion; it does not override the spawn request automatically.",
    "- If a cross-provider target is disallowed for this workspace or its provider is disconnected, the child falls back to the live parent provider/model.",
    "- Child-agent results are not visible to the user unless you summarize them.",
    "- Child agents should stay bounded; do not use them for vague or open-ended delegation.",
    "",
    "Available child-agent roles:",
    roleLines,
    "",
    config.childModelRoutingMode === "cross-provider-allowlist" && crossProviderRefs.length > 0
      ? "Available allowed child target refs for this workspace:"
      : `Available model overrides for the current provider (${providerLabel}):`,
    modelLines,
    providerSupportsUserFacingModels
      ? `- If you omit \`model\`, the child stays on **${currentModel.displayName}** (\`${currentModel.id}\`).`
      : "- If you omit `model`, the child stays on the session's current provider/model.",
  ].join("\n");
}

function renderSpawnAgentSpecificPrompt(prompt: string, config: AgentConfig): string {
  const body = buildSpawnAgentPromptBody(config);
  const markdownSection = `### spawnAgent\n${body}`;
  const toolSection = `<tool name="spawnAgent">\n${body}\n</tool>`;
  const xmlSection = `<spawnAgent>\n${body}\n</spawnAgent>`;

  if (prompt.includes('<tool name="spawnAgent">')) {
    return prompt.replace(/<tool name="spawnAgent">[\s\S]*?<\/tool>/i, toolSection);
  }
  if (prompt.includes("<spawnAgent>")) {
    return prompt.replace(/<spawnAgent>[\s\S]*?<\/spawnAgent>/i, xmlSection);
  }
  if (prompt.includes("### spawnAgent")) {
    return prompt.replace(/### spawnAgent[\s\S]*?(?=\n### notebookEdit\b)/i, markdownSection);
  }
  return prompt;
}

function normalizeLegacySpawnAgentGuidance(prompt: string): string {
  return prompt
    .replaceAll("spawnAgent (explore type)", "spawnAgent with `role: \"explorer\"`")
    .replaceAll("spawnAgent (general type)", "spawnAgent with `role: \"worker\"`");
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
  const supportedModel = resolvePromptModel(config, config.model, "model");
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
  prompt = renderMemorySpecificPrompt(prompt, config.enableMemory ?? true);
  prompt = renderSpawnAgentSpecificPrompt(prompt, config);
  prompt = normalizeLegacySpawnAgentGuidance(prompt);

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

  if (config.enableMemory ?? true) {
    const memoryStore = new MemoryStore(
      path.join(config.projectAgentDir, "memory.sqlite"),
      path.join(config.userAgentDir, "memory.sqlite")
    );
    try {
      const memorySection = await memoryStore.renderPromptSection();
      if (memorySection.trim()) {
        prompt += `\n\n${memorySection}`;
      }
    } catch {
      // Fail open so a corrupt or unreadable memory DB does not block session startup.
    }
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
  role: "explore" | "explorer" | "research" | "general"
): Promise<string> {
  const mappedRole: AgentRole =
    role === "general"
      ? "worker"
      : role === "explorer" || role === "explore"
        ? "explorer"
        : "research";
  return await loadAgentPrompt(config, mappedRole);
}

export async function loadAgentPrompt(config: AgentConfig, role: AgentRole): Promise<string> {
  const basePath = path.join(config.builtInDir, "prompts", "sub-agents", "base.md");
  const rolePath = path.join(
    config.builtInDir,
    "prompts",
    "sub-agents",
    AGENT_ROLE_DEFINITIONS[role].promptFile,
  );
  const [basePrompt, rolePrompt] = await Promise.all([
    fs.readFile(basePath, "utf-8"),
    fs.readFile(rolePath, "utf-8"),
  ]);
  return `${basePrompt.trimEnd()}\n\n${rolePrompt.trim()}\n`;
}
