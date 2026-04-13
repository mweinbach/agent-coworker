import fs from "node:fs/promises";
import path from "node:path";

import type { AgentConfig } from "./types";
import { discoverSkillsForConfig } from "./skills";
import { getResolvedModelMetadataSync, resolveModelMetadata } from "./models/metadata";
import type { ResolvedModelMetadata } from "./models/metadataTypes";
import { getChildAgentModelInfo, listChildAgentModelsWithInfo } from "./models/childAgentModelInfo";
import { parseChildModelRef } from "./models/childModelRouting";
import { MemoryStore } from "./memoryStore";
import {
  AGENT_ROLE_DEFINITIONS,
  buildSpawnAgentRolePromptLines,
  SPAWN_AGENT_COORDINATION_RULES,
  SPAWN_AGENT_MODEL_OVERRIDE_GUIDANCE,
  SPAWN_AGENT_ORCHESTRATION_RULES,
  SPAWN_AGENT_PROMPT_OVERVIEW,
  SPAWN_AGENT_WHEN_TO_USE,
} from "./server/agents/roles";
import type { AgentRoleDefinition } from "./server/agents/roles";
import type { AgentRole } from "./shared/agents";
import {
  getCodexWebSearchBackendFromProviderOptions,
  getGoogleNativeWebSearchFromProviderOptions,
  isCodexWebSearchMode,
} from "./shared/openaiCompatibleOptions";
import { isUserFacingProviderEnabled } from "./providers/catalog";
import type { ProviderName } from "./types";

async function resolveSystemTemplatePath(config: AgentConfig): Promise<string> {
  const modelMetadata = await resolveModelMetadata(config.provider, config.model, {
    allowPlaceholder: true,
    providerOptions: config.providerOptions,
    source: "model",
    log: (line) => console.warn(line),
  });
  const modelSystemPath = path.join(config.builtInDir, "prompts", modelMetadata.promptTemplate);
  try {
    await fs.access(modelSystemPath);
    return modelSystemPath;
  } catch {
    return path.join(config.builtInDir, "prompts", "system.md");
  }
}

type PromptTemplateOverlaySpec = {
  extends: string;
  replacements?: Array<{ old: string; new: string }>;
};

function normalizePromptTemplateNewlines(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let start = 0;
  while (true) {
    const found = haystack.indexOf(needle, start);
    if (found === -1) {
      return count;
    }
    count += 1;
    start = found + needle.length;
  }
}

function parsePromptTemplateOverlaySpec(raw: string, templatePath: string): PromptTemplateOverlaySpec {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in prompt template overlay ${templatePath}: ${String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Prompt template overlay must contain a JSON object: ${templatePath}`);
  }
  const overlay = parsed as { extends?: unknown; replacements?: unknown };
  if (typeof overlay.extends !== "string" || overlay.extends.trim().length === 0) {
    throw new Error(`Prompt template overlay must include a non-empty string \"extends\": ${templatePath}`);
  }
  if (overlay.replacements !== undefined && !Array.isArray(overlay.replacements)) {
    throw new Error(`Prompt template overlay replacements must be an array: ${templatePath}`);
  }
  const replacements = (overlay.replacements ?? []).map((replacement, index) => {
    if (!replacement || typeof replacement !== "object" || Array.isArray(replacement)) {
      throw new Error(`Prompt template overlay replacement ${index} must be an object: ${templatePath}`);
    }
    const candidate = replacement as { old?: unknown; new?: unknown };
    if (typeof candidate.old !== "string" || typeof candidate.new !== "string") {
      throw new Error(`Prompt template overlay replacement ${index} must include string old/new values: ${templatePath}`);
    }
    return { old: candidate.old, new: candidate.new };
  });
  return {
    extends: overlay.extends,
    ...(replacements.length > 0 ? { replacements } : {}),
  };
}

async function loadPromptTemplate(templatePath: string, ancestors = new Set<string>()): Promise<string> {
  const resolvedTemplatePath = path.resolve(templatePath);
  if (ancestors.has(resolvedTemplatePath)) {
    throw new Error(`Prompt template overlay cycle detected at ${resolvedTemplatePath}`);
  }

  const raw = normalizePromptTemplateNewlines(await fs.readFile(resolvedTemplatePath, "utf-8"));
  if (!resolvedTemplatePath.endsWith(".json")) {
    return raw;
  }

  const overlay = parsePromptTemplateOverlaySpec(raw, resolvedTemplatePath);
  const nextAncestors = new Set(ancestors);
  nextAncestors.add(resolvedTemplatePath);
  let prompt = await loadPromptTemplate(path.resolve(path.dirname(resolvedTemplatePath), overlay.extends), nextAncestors);

  for (const replacement of overlay.replacements ?? []) {
    const occurrences = countOccurrences(prompt, replacement.old);
    if (occurrences !== 1) {
      throw new Error(
        `Prompt template overlay replacement must match exactly once in ${overlay.extends}; got ${occurrences} matches in ${resolvedTemplatePath}`,
      );
    }
    prompt = prompt.replace(replacement.old, replacement.new);
  }

  return prompt;
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

function renderCapabilitySpecificPrompt(prompt: string, modelMetadata: ResolvedModelMetadata): string {
  if (modelMetadata.supportsImageInput) return prompt;

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

function configuredCodexWebSearchMode(config: AgentConfig): "disabled" | "cached" | "live" | undefined {
  const providerOptions = config.providerOptions;
  if (!providerOptions || typeof providerOptions !== "object" || Array.isArray(providerOptions)) return undefined;
  const codexOptions = providerOptions["codex-cli"];
  if (!codexOptions || typeof codexOptions !== "object" || Array.isArray(codexOptions)) return undefined;
  return isCodexWebSearchMode(codexOptions.webSearchMode) ? codexOptions.webSearchMode : undefined;
}

function renderCodexNativeWebSearchPrompt(prompt: string, config: AgentConfig): string {
  if (config.provider !== "codex-cli") {
    return prompt;
  }

  const backend = getCodexWebSearchBackendFromProviderOptions(config.providerOptions);
  if (backend === "exa") {
    return `${prompt}\n\n## Codex Web Search Backend\n\nThis Codex CLI session is configured to use the local Exa-backed webSearch tool instead of provider-native web search.\n\n- Use the local webSearch tool for current web lookup.\n- Use local webFetch when you need the full contents of a specific page or need to download a direct file.\n- Do not assume provider-native citations or provider-native web-search actions are available in this session.`;
  }

  const mode = configuredCodexWebSearchMode(config) ?? "live";
  if (mode === "disabled") {
    return `${prompt}\n\n## Codex Web Search Disabled\n\nThis Codex CLI session is configured for the native web-search backend, but web search is currently disabled.\n\n- Do not call local webSearch for ordinary lookup.\n- Do not expect provider-native web search to be available until the workspace setting changes.\n- Only use local webFetch when the task explicitly requires downloading or saving a direct file into the local workspace.`;
  }

  return `${prompt}\n\n## Codex Native Web Search\n\nThis Codex CLI session is configured to use provider-native web search for anything beyond your knowledge cutoff.\n\n- Use provider-native web search for general web lookup, opening specific pages, and finding within a page.\n- Prefer provider-native citations and sources when they are available. Do not add a manual \"Sources:\" section just to compensate for native citations.\n- Do not use local webFetch for ordinary HTML page reading in native-web-search sessions.\n- Only use local webFetch when the task explicitly requires downloading or saving a direct file into the local workspace and provider-native web search cannot satisfy that requirement.`;
}

function renderGoogleNativeToolsPrompt(prompt: string, config: AgentConfig): string {
  if (config.provider !== "google") {
    return prompt;
  }

  const nativeWebSearch = getGoogleNativeWebSearchFromProviderOptions(config.providerOptions);
  if (!nativeWebSearch) {
    return prompt;
  }

  const sections: string[] = [
    "## Gemini Native Web Tools",
    "",
    "This Gemini API session is configured to use provider-native Google Search and URL Context for web access.",
    "",
    "- Use Gemini's built-in web search for current web lookup instead of the local `webSearch` tool.",
    "- Use Gemini's built-in URL Context instead of local `webFetch` for ordinary page reading.",
    "- Prefer provider-native citations and sources when they are available. Do not add a manual \"Sources:\" section just to compensate for native citations.",
    "- Only use local file tools when the task explicitly requires saving content into the workspace.",
  ];

  return `${prompt}\n\n${sections.join("\n")}`;
}

const PROVIDER_DISPLAY_NAMES: Record<ProviderName, string> = {
  google: "Google",
  openai: "OpenAI",
  anthropic: "Anthropic",
  baseten: "Baseten",
  together: "Together AI",
  fireworks: "Fireworks AI",
  nvidia: "NVIDIA",
  lmstudio: "LM Studio",
  "opencode-go": "OpenCode Go",
  "opencode-zen": "OpenCode Zen",
  "codex-cli": "Codex CLI",
};

const SPAWN_AGENT_MARKDOWN_SECTION_PLACEHOLDER = "{{spawnAgentMarkdownSection}}";
const SPAWN_AGENT_TOOL_SECTION_PLACEHOLDER = "{{spawnAgentToolSection}}";
const SPAWN_AGENT_XML_SECTION_PLACEHOLDER = "{{spawnAgentXmlSection}}";
const SPAWN_AGENT_PROMPT_BODY_PLACEHOLDER = "{{spawnAgentPromptBody}}";

export function buildSpawnAgentPromptBody(config: AgentConfig): string {
  const providerLabel = PROVIDER_DISPLAY_NAMES[config.provider] ?? config.provider;
  const currentModel = getResolvedModelMetadataSync(config.provider, config.model, "model");
  const roleLines = buildSpawnAgentRolePromptLines().join("\n");
  const whenToUseLines = SPAWN_AGENT_WHEN_TO_USE.map((item) => `- **${item.label}**: ${item.description}`);
  const orchestrationRuleLines = SPAWN_AGENT_ORCHESTRATION_RULES.map((rule) => `- ${rule}`);
  const coordinationRuleLines = SPAWN_AGENT_COORDINATION_RULES.map((rule) => `- ${rule}`);
  const modelOverrideGuidanceLines = SPAWN_AGENT_MODEL_OVERRIDE_GUIDANCE.map((rule) => `- ${rule}`);

  const crossProviderRefs = (config.allowedChildModelRefs ?? [])
    .map((ref) => {
      try {
        const parsed = parseChildModelRef(ref, config.provider, "child target");
        const supported = getResolvedModelMetadataSync(parsed.provider, parsed.modelId, "child target");
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
    : config.provider === "lmstudio"
      ? "- Any LM Studio LLM key discovered at runtime is allowed. Use either the bare key or `lmstudio:<modelKey>`."
    : !providerSupportsUserFacingModels
      ? "- No user-facing child model overrides are available for this provider."
      : listChildAgentModelsWithInfo(config.provider)
          .map((model) => `- **${model.displayName}** (\`${model.id}\`): ${model.bestFor ?? "general-purpose work on this provider"}.`)
          .join("\n");

  return [
    SPAWN_AGENT_PROMPT_OVERVIEW,
    "",
    "When to use:",
    ...whenToUseLines,
    "",
    "Orchestration rules:",
    ...orchestrationRuleLines,
    "",
    "Coordinator rules:",
    ...coordinationRuleLines,
    "",
    "Model override guidance:",
    ...modelOverrideGuidanceLines,
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

function buildSpawnAgentPromptSections(config: AgentConfig): {
  body: string;
  markdownSection: string;
  toolSection: string;
  xmlSection: string;
} {
  const body = buildSpawnAgentPromptBody(config);
  return {
    body,
    markdownSection: `### spawnAgent\n${body}`,
    toolSection: `<tool name="spawnAgent">\n${body}\n</tool>`,
    xmlSection: `<spawnAgent>\n${body}\n</spawnAgent>`,
  };
}

function renderSpawnAgentSpecificPrompt(prompt: string, config: AgentConfig): string {
  const { body, markdownSection, toolSection, xmlSection } = buildSpawnAgentPromptSections(config);

  if (prompt.includes(SPAWN_AGENT_MARKDOWN_SECTION_PLACEHOLDER)) {
    return prompt.replaceAll(SPAWN_AGENT_MARKDOWN_SECTION_PLACEHOLDER, markdownSection);
  }
  if (prompt.includes(SPAWN_AGENT_TOOL_SECTION_PLACEHOLDER)) {
    return prompt.replaceAll(SPAWN_AGENT_TOOL_SECTION_PLACEHOLDER, toolSection);
  }
  if (prompt.includes(SPAWN_AGENT_XML_SECTION_PLACEHOLDER)) {
    return prompt.replaceAll(SPAWN_AGENT_XML_SECTION_PLACEHOLDER, xmlSection);
  }
  if (prompt.includes(SPAWN_AGENT_PROMPT_BODY_PLACEHOLDER)) {
    return prompt.replaceAll(SPAWN_AGENT_PROMPT_BODY_PLACEHOLDER, body);
  }

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

function buildEnabledPluginSummary(skills: Array<{ name: string; description: string; plugin?: { displayName: string; name: string } }>): string[] {
  const seen = new Map<string, { displayName: string; namespacedSkills: string[] }>();
  for (const skill of skills) {
    if (!skill.plugin) continue;
    const key = skill.plugin.name;
    const entry = seen.get(key) ?? {
      displayName: skill.plugin.displayName,
      namespacedSkills: [],
    };
    entry.namespacedSkills.push(skill.name);
    seen.set(key, entry);
  }
  return [...seen.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([pluginName, entry]) => {
      const skillsList = entry.namespacedSkills.sort((left, right) => left.localeCompare(right)).join(", ");
      return `- **${entry.displayName}** (\`${pluginName}\`): ${skillsList}`;
    });
}

function buildAvailableSubagentTypesList(): string {
  return Object.values(AGENT_ROLE_DEFINITIONS)
    .map((role) => `- \`${role.id}\`: ${role.description}`)
    .join("\n");
}

function selectRoleByCapabilities(
  roles: AgentRoleDefinition[],
  options: {
    preferredIds: AgentRole[];
    requireReadOnly?: boolean;
    excludeId?: AgentRole;
  },
): AgentRoleDefinition | null {
  const filtered = roles.filter((role) => {
    if (options.requireReadOnly !== undefined && role.readOnly !== options.requireReadOnly) {
      return false;
    }
    if (options.excludeId && role.id === options.excludeId) {
      return false;
    }
    return true;
  });
  if (filtered.length === 0) return null;

  for (const preferredId of options.preferredIds) {
    const preferred = filtered.find((role) => role.id === preferredId);
    if (preferred) return preferred;
  }
  return filtered[0] ?? null;
}

function resolveDefaultSubagentRoleIds(): {
  discoveryRoleId: string;
  implementationRoleId: string;
  verificationRoleId: string;
} {
  const roles = Object.values(AGENT_ROLE_DEFINITIONS);
  const discovery = selectRoleByCapabilities(roles, {
    preferredIds: ["explorer", "research"],
    requireReadOnly: true,
  });
  const implementation = selectRoleByCapabilities(roles, {
    preferredIds: ["worker", "default"],
    requireReadOnly: false,
  });
  const verification = selectRoleByCapabilities(roles, {
    preferredIds: ["reviewer", "research", "explorer"],
    requireReadOnly: true,
    excludeId: discovery?.id,
  }) ?? discovery;

  return {
    discoveryRoleId: discovery?.id ?? "explorer",
    implementationRoleId: implementation?.id ?? "worker",
    verificationRoleId: verification?.id ?? discovery?.id ?? "reviewer",
  };
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
    "- If the `slides` skill is available and the task is presentation authoring, use that path instead of defaulting to ad hoc `python-pptx` generation. `python-pptx` is an inspection or last-resort fallback, not the default deck-authoring path.",
    "- Do not count search result pages, article URLs, provider-native search metadata, or HTML previews as images. Only claim images were added after direct image assets were downloaded or local image files were read.",
    "- Placeholder, stock stand-ins, or unrelated fallback images are degraded output and must be disclosed explicitly instead of being presented as if they satisfy the original image request.",
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

function buildShellExecutionPolicySection(): string {
  return [
    "## Shell Execution Policy",
    "",
    "- On Windows, the `bash` tool actually runs PowerShell. Prefer `pwsh` semantics when available and assume a fallback to `powershell.exe`.",
    "- On Windows, do not rely on `&&`, `export`, or `source`. Use PowerShell-safe sequencing such as `;`, separate tool calls, and `$env:NAME = \"value\"`.",
    "- On Windows, prefer `py -3` or `python` for Python commands.",
    "- When commands depend on each other, use platform-appropriate sequencing instead of assuming Unix shell chaining works everywhere.",
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
  const supportedModel = await resolveModelMetadata(config.provider, config.model, {
    allowPlaceholder: true,
    providerOptions: config.providerOptions,
    source: "model",
    log: (line) => console.warn(line),
  });
  const systemPath = await resolveSystemTemplatePath(config);
  let prompt = await loadPromptTemplate(systemPath);

  const skills = await discoverSkillsForConfig(config);

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

  const defaultSubagentRoles = resolveDefaultSubagentRoleIds();
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
    availableSubagentTypes: buildAvailableSubagentTypesList(),
    defaultDiscoveryRole: defaultSubagentRoles.discoveryRoleId,
    defaultImplementationRole: defaultSubagentRoles.implementationRoleId,
    defaultVerificationRole: defaultSubagentRoles.verificationRoleId,
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
  prompt = renderCodexNativeWebSearchPrompt(prompt, config);
  prompt = renderGoogleNativeToolsPrompt(prompt, config);
  prompt = renderSpawnAgentSpecificPrompt(prompt, config);
  prompt = normalizeLegacySpawnAgentGuidance(prompt);

  prompt += `\n\n${buildSkillPolicySection(vars.skillNames, vars.skillExamples, config)}`;
  prompt += `\n\n${buildShellExecutionPolicySection()}`;

  const enabledPluginLines = buildEnabledPluginSummary(skills);
  if (enabledPluginLines.length > 0) {
    prompt +=
      "\n\n## Enabled Plugin Bundles\n\nInstalled plugin bundles can contribute read-only skills and MCP servers. Plugin skills use namespaced runtime names and should be loaded exactly as listed.\n\n"
      + enabledPluginLines.join("\n");
  }

  if (skills.length > 0) {
    const list = skills
      .map(
        (s) =>
          `- **${s.name}**: ${s.description} (location: ${s.path}; source: ${s.source}${s.plugin ? `; plugin: ${s.plugin.displayName}` : ""}; triggers: ${s.triggers.join(", ")})`
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
