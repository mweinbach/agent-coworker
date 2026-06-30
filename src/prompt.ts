import fs from "node:fs/promises";
import path from "node:path";
import {
  AdvancedMemoryStore,
  resolveMemoriesDir,
  resolveMemoryFolderName,
} from "./advancedMemory/store";
import { MemoryStore } from "./memoryStore";
import { getChildAgentModelInfo, listChildAgentModelsWithInfo } from "./models/childAgentModelInfo";
import { parseChildModelRef } from "./models/childModelRouting";
import { getResolvedModelMetadataSync, resolveModelMetadata } from "./models/metadata";
import type { ResolvedModelMetadata } from "./models/metadataTypes";
import { loadProjectInstructionsSection } from "./projectInstructions";
import { isUserFacingProviderEnabled } from "./providers/catalog";
import {
  formatAgentProfilePromptSummaries,
  readAgentProfilesCatalog,
} from "./server/agents/profiles";
import type { AgentRoleDefinition } from "./server/agents/roles";
import {
  AGENT_ROLE_DEFINITIONS,
  buildSpawnAgentRolePromptLines,
  SPAWN_AGENT_COORDINATION_RULES,
  SPAWN_AGENT_MODEL_OVERRIDE_GUIDANCE,
  SPAWN_AGENT_ORCHESTRATION_RULES,
  SPAWN_AGENT_PROMPT_OVERVIEW,
  SPAWN_AGENT_WHEN_TO_USE,
} from "./server/agents/roles";
import type { AgentProfileSnapshot } from "./shared/agentProfiles";
import type { AgentRole } from "./shared/agents";
import {
  getGoogleNativeWebSearchFromProviderOptions,
  getLocalWebSearchProviderFromProviderOptions,
} from "./shared/openaiCompatibleOptions";
import { discoverSkillsForConfig } from "./skills";
import type { AgentConfig, ProviderName } from "./types";
import { sameWorkspacePath } from "./utils/workspacePath";
import { buildWorkspaceMapSection } from "./workspace/map";

function buildProjectInstructionsSection(config: AgentConfig): string {
  const text = (config.userProfile?.instructions ?? "").trim();
  if (!text) return "";
  return ["## Project instructions", "", text].join("\n");
}

function resolveProjectInstructionsTargetDir(config: AgentConfig): string {
  const workspaceRoot = path.resolve(path.dirname(config.projectCoworkDir));
  const executionCwd = path.resolve(config.workingDirectory);
  if (sameWorkspacePath(workspaceRoot, executionCwd)) {
    return executionCwd;
  }

  const relativeToWorkspace = path.relative(workspaceRoot, executionCwd);
  if (
    relativeToWorkspace &&
    relativeToWorkspace !== ".." &&
    !relativeToWorkspace.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativeToWorkspace)
  ) {
    return executionCwd;
  }

  return workspaceRoot;
}

async function appendWorkspaceContextBlocks(
  prompt: string,
  config: AgentConfig,
  opts?: { includeProjectInstructions?: boolean },
): Promise<string> {
  const blocks: string[] = [prompt];

  const agentsHierarchySection = await loadProjectInstructionsSection(
    resolveProjectInstructionsTargetDir(config),
  );
  if (agentsHierarchySection) {
    blocks.push(agentsHierarchySection);
  }

  if (opts?.includeProjectInstructions) {
    const projectInstructions = buildProjectInstructionsSection(config);
    if (projectInstructions) {
      blocks.push(projectInstructions);
    }
  }
  blocks.push(buildWorkspaceMapSection(config));
  return blocks.join("\n\n");
}

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

function normalizePromptTemplateNewlines(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

/**
 * Load a model-specific system prompt template. Each model maps to a single,
 * self-contained Markdown template (see `promptTemplate` in the model registry);
 * dynamic sections are filled later via `{{...}}` template variables, not by
 * composing/overlaying separate files. Newlines are normalized to `\n`.
 */
async function loadPromptTemplate(templatePath: string): Promise<string> {
  const resolvedTemplatePath = path.resolve(templatePath);
  return normalizePromptTemplateNewlines(await fs.readFile(resolvedTemplatePath, "utf-8"));
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

// Image-input guidance in the prompt templates is wrapped in
// `<image_input>...</image_input>` spans (see prompts/system.md). Because the markup
// lives inline with the guidance it gates, there is no separate set of phrase-matching
// regexes to keep in sync with the wording — edit the prompt freely and the spans travel
// with it. A regression test renders every text-only model and asserts the guidance is
// gone, so a new text-only model on an un-marked-up template fails loudly instead of
// silently shipping image instructions.
const IMAGE_INPUT_SPAN = /<image_input>[\s\S]*?<\/image_input>/g;
const IMAGE_INPUT_DELIMITERS = /<\/?image_input>/g;

function renderCapabilitySpecificPrompt(
  prompt: string,
  modelMetadata: ResolvedModelMetadata,
): string {
  if (modelMetadata.supportsImageInput) {
    // Multimodal: keep the guidance, drop only the delimiters. Stripping just the tag
    // text reproduces the original wording byte-for-byte.
    return prompt.replace(IMAGE_INPUT_DELIMITERS, "");
  }
  // Text-only: omit the delimited image-input guidance entirely, then collapse any blank
  // lines left where a whole paragraph was removed.
  return prompt.replace(IMAGE_INPUT_SPAN, "").replace(/\n{3,}/g, "\n\n");
}

function renderMemorySpecificPrompt(
  prompt: string,
  opts: { enabled: boolean; advanced?: boolean },
): string {
  // Advanced memory replaces the legacy `memory`/AGENT.md flow with the
  // recallMemory/readPastConversation tools + an injected Memory Index, so the
  // legacy guidance is stripped while the advanced section is appended later.
  if (opts.enabled && !opts.advanced) return prompt;

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
  out = stripPromptLine(out, /^\s*-\s*Memory:\s*`?\.cowork\/AGENT\.md/i);
  out = stripPromptLine(out, /^\s*Memory:\s*\.cowork\/AGENT\.md/i);
  out = out.replace(/\n{3,}/g, "\n\n").trimEnd();

  if (opts.advanced) {
    // Advanced memory guidance + index are appended later via the store.
    return out;
  }

  return `${out}\n\n## Memory Disabled\n\nPersistent memory is disabled for this workspace. Do not read or write AGENT.md and do not call the memory tool.`;
}

function renderCodexNativeWebSearchPrompt(prompt: string, config: AgentConfig): string {
  if (config.provider !== "codex-cli") {
    return prompt;
  }

  return `${prompt}\n\n## Codex Web Search Backend\n\nCodex app-server owns web search and page fetching for this Codex CLI session.\n\n- Use Codex-native web search/fetch capabilities for current web lookup and page reading.\n- Do not call local Cowork webSearch or webFetch tools; they are reserved for non-Codex providers.`;
}

function renderLocalWebToolProviderPrompt(prompt: string, config: AgentConfig): string {
  const localProvider = getLocalWebSearchProviderFromProviderOptions(config.providerOptions);
  const providerName = localProvider === "parallel" ? "Parallel" : "Exa";
  const apiKeyEnv = localProvider === "parallel" ? "PARALLEL_API_KEY" : "EXA_API_KEY";
  const credentialGuidance = `- For local webSearch, this workspace uses ${providerName}. If credentials are missing, ask the user to save a ${providerName} API key in Providers > Tool Providers or set \`${apiKeyEnv}\`.`;
  const exaCredentialGuidancePatterns = [
    /^- For the Google provider in this app, webSearch is Exa-backed\. If credentials are missing, ask the user to save an Exa API key in provider settings \(Google -> Exa API key\) or set `EXA_API_KEY`\.$/gm,
    /^- For the Google provider in this app, webSearch uses Exa\. If webSearch is disabled due missing credentials, ask the user to save an Exa API key in provider settings \(Google -> Exa API key\) or set `EXA_API_KEY`\.$/gm,
  ];
  let out = prompt;
  for (const pattern of exaCredentialGuidancePatterns) {
    out = out.replace(pattern, credentialGuidance);
  }
  return out.replaceAll("Exa-extracted content", `${providerName}-extracted content`);
}

function renderGoogleNativeToolsPrompt(prompt: string, config: AgentConfig): string {
  if (config.provider !== "google") {
    return prompt;
  }

  const nativeWebSearch = getGoogleNativeWebSearchFromProviderOptions(config.providerOptions);
  if (!nativeWebSearch) {
    const localProvider = getLocalWebSearchProviderFromProviderOptions(config.providerOptions);
    const providerName = localProvider === "parallel" ? "Parallel" : "Exa";
    return `${prompt}\n\n## Gemini Web Search Fallback\n\nThis Gemini API session is configured to use the local ${providerName}-backed webSearch tool when current web search is needed.\n\n- Use the local webSearch tool for current web lookup instead of Gemini built-in Google Search.\n- Use local webFetch when you need the full contents of a specific page or need to download a direct file.\n- Do not assume provider-native citations or provider-native URL Context are available in this session.`;
  }

  const sections: string[] = [
    "## Gemini Native Web Tools",
    "",
    "This Gemini API session is configured to use provider-native Google Search and URL Context for web access.",
    "",
    "- Use Gemini's built-in web search for current web lookup instead of the local `webSearch` tool.",
    "- Use Gemini's built-in URL Context instead of local `webFetch` for ordinary page reading.",
    '- Prefer provider-native citations and sources when they are available. Do not add a manual "Sources:" section just to compensate for native citations.',
    "- Only use local file tools when the task explicitly requires saving content into the workspace.",
  ];

  return `${prompt}\n\n${sections.join("\n")}`;
}

const PROVIDER_DISPLAY_NAMES: Record<ProviderName, string> = {
  google: "Google",
  openai: "OpenAI",
  anthropic: "Anthropic",
  bedrock: "Amazon Bedrock",
  baseten: "Baseten",
  together: "Together AI",
  fireworks: "Fireworks AI",
  firepass: "Fire Pass",
  nvidia: "NVIDIA",
  lmstudio: "LM Studio",
  minimax: "MiniMax",
  "opencode-go": "OpenCode Go",
  "opencode-zen": "OpenCode Zen",
  "codex-cli": "Codex CLI",
  antigravity: "Antigravity",
};

const SPAWN_AGENT_MARKDOWN_SECTION_PLACEHOLDER = "{{spawnAgentMarkdownSection}}";
const SPAWN_AGENT_TOOL_SECTION_PLACEHOLDER = "{{spawnAgentToolSection}}";
const SPAWN_AGENT_XML_SECTION_PLACEHOLDER = "{{spawnAgentXmlSection}}";
const SPAWN_AGENT_PROMPT_BODY_PLACEHOLDER = "{{spawnAgentPromptBody}}";

export function buildSpawnAgentPromptBody(
  config: AgentConfig,
  profileLines: readonly string[] = [],
): string {
  const providerLabel = PROVIDER_DISPLAY_NAMES[config.provider] ?? config.provider;
  const currentModel = getResolvedModelMetadataSync(config.provider, config.model, "model");
  const roleLines = buildSpawnAgentRolePromptLines().join("\n");
  const whenToUseLines = SPAWN_AGENT_WHEN_TO_USE.map(
    (item) => `- **${item.label}**: ${item.description}`,
  );
  const orchestrationRuleLines = SPAWN_AGENT_ORCHESTRATION_RULES.map((rule) => `- ${rule}`);
  const coordinationRuleLines = SPAWN_AGENT_COORDINATION_RULES.map((rule) => `- ${rule}`);
  const modelOverrideGuidanceLines = SPAWN_AGENT_MODEL_OVERRIDE_GUIDANCE.map((rule) => `- ${rule}`);

  const crossProviderRefs = (config.allowedChildModelRefs ?? [])
    .map((ref) => {
      try {
        const parsed = parseChildModelRef(ref, config.provider, "child target");
        const supported = getResolvedModelMetadataSync(
          parsed.provider,
          parsed.modelId,
          "child target",
        );
        const bestFor =
          getChildAgentModelInfo(parsed.provider, parsed.modelId)?.bestFor ??
          "general-purpose work on this provider";
        const displayProvider = PROVIDER_DISPLAY_NAMES[parsed.provider] ?? parsed.provider;
        return `- **${displayProvider} / ${supported.displayName}** (\`${parsed.ref}\`): ${bestFor}.`;
      } catch {
        return null;
      }
    })
    .filter((line): line is string => Boolean(line));
  const providerSupportsUserFacingModels = isUserFacingProviderEnabled(config.provider);
  const modelLines =
    config.childModelRoutingMode === "cross-provider-allowlist" && crossProviderRefs.length > 0
      ? crossProviderRefs.join("\n")
      : config.provider === "lmstudio"
        ? "- Any LM Studio LLM key discovered at runtime is allowed. Use either the bare key or `lmstudio:<modelKey>`."
        : !providerSupportsUserFacingModels
          ? "- No user-facing child model overrides are available for this provider."
          : listChildAgentModelsWithInfo(config.provider)
              .map(
                (model) =>
                  `- **${model.displayName}** (\`${model.id}\`): ${model.bestFor ?? "general-purpose work on this provider"}.`,
              )
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
    ...(profileLines.length > 0
      ? [
          "",
          "Available specialized subagent profiles:",
          "Use `profileRef` with either the scoped ref or the bare id. If both `profileRef` and `role` are present, `profileRef` wins.",
          ...profileLines,
        ]
      : []),
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

function buildSpawnAgentPromptSections(
  config: AgentConfig,
  profileLines: readonly string[] = [],
): {
  body: string;
  markdownSection: string;
  toolSection: string;
  xmlSection: string;
} {
  const body = buildSpawnAgentPromptBody(config, profileLines);
  return {
    body,
    markdownSection: `### spawnAgent\n${body}`,
    toolSection: `<tool name="spawnAgent">\n${body}\n</tool>`,
    xmlSection: `<spawnAgent>\n${body}\n</spawnAgent>`,
  };
}

function renderSpawnAgentSpecificPrompt(
  prompt: string,
  config: AgentConfig,
  profileLines: readonly string[] = [],
): string {
  const { body, markdownSection, toolSection, xmlSection } = buildSpawnAgentPromptSections(
    config,
    profileLines,
  );

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
    return prompt.replace(/### spawnAgent[\s\S]*?(?=\n### skill\b)/i, markdownSection);
  }
  return prompt;
}

function normalizeLegacySpawnAgentGuidance(prompt: string): string {
  return prompt
    .replaceAll("spawnAgent (explore type)", 'spawnAgent with `role: "explorer"`')
    .replaceAll("spawnAgent (general type)", 'spawnAgent with `role: "worker"`');
}

function buildSkillSearchOrder(config: AgentConfig): string {
  const labels = ["project", "global (~/.cowork/skills)", "built-in"];
  return config.skillsDirs
    .map((_, index) => labels[index] ?? `skills-dir-${index + 1}`)
    .join(" -> ");
}

function buildEnabledPluginSummary(
  skills: Array<{
    name: string;
    description: string;
    plugin?: { displayName: string; name: string };
  }>,
): string[] {
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
      const skillsList = entry.namespacedSkills
        .sort((left, right) => left.localeCompare(right))
        .join(", ");
      return `- **${entry.displayName}** (\`${pluginName}\`): ${skillsList}`;
    });
}

function buildAvailableSubagentTypesList(): string {
  return Object.values(AGENT_ROLE_DEFINITIONS)
    .map((role) => `- \`${role.id}\`: ${role.description}`)
    .join("\n");
}

async function readAgentProfilePromptLines(config: AgentConfig): Promise<string[]> {
  try {
    return formatAgentProfilePromptSummaries(await readAgentProfilesCatalog(config));
  } catch {
    return [];
  }
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
  const verification =
    selectRoleByCapabilities(roles, {
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

function buildSkillPolicySection(
  skillNames: string,
  skillExamples: string,
  config: AgentConfig,
): string {
  return [
    "## Skill Loading Policy (Strict)",
    "",
    "- Before creating any domain deliverable (spreadsheet, document, presentation, PDF), call the `skill` tool first when a matching skill is listed as available in this run.",
    "- If no listed skill matches the requested deliverable, continue with the available tools; do not invent a skill name or guess a `SKILL.md` path.",
    "- If the user prompt explicitly says to use the `skill` tool, that call is mandatory and must happen before related artifact creation.",
    "- Do not write build scripts or output artifacts for those domains before loading the corresponding skill.",
    "- If the task spans multiple deliverable domains, load each required skill before creating files.",
    "- Never claim a skill was loaded unless the `skill` tool call actually occurred in this run.",
    "- If the `presentations` skill is available and the task is presentation authoring, use that path instead of defaulting to ad hoc `python-pptx` generation. `python-pptx` is an inspection or last-resort fallback, not the default deck-authoring path.",
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
    '- On Windows, do not rely on `&&`, `export`, or `source`. Use PowerShell-safe sequencing such as `;`, separate tool calls, and `$env:NAME = "value"`.',
    "- On Windows, prefer `py -3` or `python` for Python commands.",
    "- When commands depend on each other, use platform-appropriate sequencing instead of assuming Unix shell chaining works everywhere.",
  ].join("\n");
}

async function _loadHotCache(config: AgentConfig): Promise<string> {
  const candidates = [
    path.join(config.projectCoworkDir, "AGENT.md"),
    path.join(config.userCoworkDir, "AGENT.md"),
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

  const discoveredSkills = await discoverSkillsForConfig(config);
  const agentProfilePromptLines = await readAgentProfilePromptLines(config);
  const skills = discoveredSkills;

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
    skillNames: skillNames || "none",
    skillExamples:
      skillExamples ||
      "- No skills are available in this run. Continue without the `skill` tool instead of guessing a skill name or path.",
  };

  prompt = renderTemplateVariables(prompt, vars);
  prompt = renderCapabilitySpecificPrompt(prompt, supportedModel);
  prompt = renderMemorySpecificPrompt(prompt, {
    enabled: config.enableMemory ?? true,
    advanced: config.advancedMemory ?? false,
  });
  prompt = renderLocalWebToolProviderPrompt(prompt, config);
  prompt = renderCodexNativeWebSearchPrompt(prompt, config);
  prompt = renderGoogleNativeToolsPrompt(prompt, config);
  prompt = renderSpawnAgentSpecificPrompt(prompt, config, agentProfilePromptLines);
  prompt = normalizeLegacySpawnAgentGuidance(prompt);

  // User profile instructions render via {{userProfileInstructions}} in system templates; do not duplicate.
  // Hierarchical AGENTS.md / AGENTS.override.md are appended separately from memory (.cowork/AGENT.md).
  prompt = await appendWorkspaceContextBlocks(prompt, config, {
    includeProjectInstructions: false,
  });

  prompt += `\n\n${buildSkillPolicySection(vars.skillNames, vars.skillExamples, config)}`;
  prompt += `\n\n${buildShellExecutionPolicySection()}`;

  const enabledPluginLines = buildEnabledPluginSummary(skills);
  if (enabledPluginLines.length > 0) {
    prompt +=
      "\n\n## Enabled Plugin Bundles\n\nInstalled plugin bundles can contribute read-only skills and MCP servers. Plugin skills use namespaced runtime names and should be loaded exactly as listed.\n\n" +
      enabledPluginLines.join("\n");
  }

  if (skills.length > 0) {
    const list = skills
      .map(
        (s) =>
          `- **${s.name}**: ${s.description} (location: ${s.path}; source: ${s.source}${s.plugin ? `; plugin: ${s.plugin.displayName}` : ""}; triggers: ${s.triggers.join(", ")})`,
      )
      .join("\n");
    prompt +=
      "\n\n## Available Skills\n\nLoad these with the skill tool before creating the relevant output:\n\n" +
      list;
  }

  if (config.advancedMemory) {
    try {
      const store = new AdvancedMemoryStore(resolveMemoriesDir(config));
      const memorySection = await store.renderPromptSection(resolveMemoryFolderName(config));
      if (memorySection.trim()) {
        prompt += `\n\n${memorySection}`;
      }
    } catch {
      // Fail open so an unreadable memory tree does not block session startup.
    }
  } else if (config.enableMemory ?? true) {
    const memoryStore = new MemoryStore(
      config.projectMemoryDbPath ?? path.join(config.projectCoworkDir, "memory.sqlite"),
      path.join(config.userCoworkDir, "memory.sqlite"),
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

  const promptSkills = skills.map((s) => ({ name: s.name, description: s.description }));
  return { prompt, discoveredSkills: promptSkills };
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
  role: "explore" | "explorer" | "research" | "general",
): Promise<string> {
  const mappedRole: AgentRole =
    role === "general"
      ? "worker"
      : role === "explorer" || role === "explore"
        ? "explorer"
        : "research";
  return await loadAgentPrompt(config, mappedRole);
}

export async function loadAgentPrompt(
  config: AgentConfig,
  role: AgentRole,
  profile?: AgentProfileSnapshot,
): Promise<string> {
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
  const profilePrompt = profile?.prompt.trim();
  const effectiveRolePrompt = profilePrompt || rolePrompt.trim();
  const combined = [
    basePrompt.trimEnd(),
    effectiveRolePrompt,
    ...(profile ? [buildAgentProfilePromptSection(profile)] : []),
  ].join("\n\n");
  return await appendWorkspaceContextBlocks(combined, config, { includeProjectInstructions: true });
}

function buildAgentProfilePromptSection(profile: AgentProfileSnapshot): string {
  const lines = [
    "## Specialized Subagent Profile",
    "",
    `Profile: ${profile.displayName} (\`${profile.ref}\`)`,
    profile.description ? `Description: ${profile.description}` : "",
    "",
    "Profile policy:",
    `- Base role safety baseline: \`${profile.baseRole}\`.`,
    `- Built-in tools allowed by this profile: ${formatInlineList(profile.allowedBuiltInTools)}.`,
    `- MCP servers allowed by this profile: ${formatInlineList(profile.allowedMcpServers)}.`,
    `- Skills allowed by this profile: ${formatInlineList(profile.skillNames)}.`,
    "- Do not attempt to load skills, built-in tools, or MCP servers outside this profile policy.",
  ].filter(Boolean);
  return lines.join("\n");
}

function formatInlineList(values: readonly string[]): string {
  if (values.length === 0) return "none";
  return values.map((value) => `\`${value}\``).join(", ");
}
