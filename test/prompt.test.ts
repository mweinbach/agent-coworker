import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadAgentPrompt, loadSystemPrompt, loadSubAgentPrompt, loadSystemPromptWithSkills } from "../src/prompt";
import {
  AGENT_ROLE_DEFINITIONS,
  buildSpawnAgentRolePromptLines,
  SPAWN_AGENT_COORDINATION_RULES,
  SPAWN_AGENT_MODEL_OVERRIDE_GUIDANCE,
  SPAWN_AGENT_ORCHESTRATION_RULES,
  SPAWN_AGENT_PROMPT_OVERVIEW,
  SPAWN_AGENT_WHEN_TO_USE,
} from "../src/server/agents/roles";
import type { AgentConfig } from "../src/types";

function repoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..");
}

async function makeTmpDirs() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-prompt-"));
  const cwd = path.join(tmp, "project");
  const home = path.join(tmp, "home");
  const builtIn = path.join(tmp, "built-in");
  await fs.mkdir(cwd, { recursive: true });
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(builtIn, { recursive: true });
  return { tmp, cwd, home, builtIn };
}

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  const base: AgentConfig = {
    provider: "google",
    model: "gemini-3.1-pro-preview",
    preferredChildModel: "gemini-3.1-pro-preview",
    workingDirectory: "/test/working",
    userName: "TestUser",
    knowledgeCutoff: "End of May 2025",
    projectAgentDir: "/test/project/.agent",
    userAgentDir: "/test/home/.agent",
    builtInDir: repoRoot(),
    builtInConfigDir: path.join(repoRoot(), "config"),
    skillsDirs: [
      "/test/project/.agent/skills",
      "/test/home/.agent/skills",
      path.join(repoRoot(), "skills"),
    ],
    memoryDirs: ["/test/project/.agent/memory", "/test/home/.agent/memory"],
    configDirs: [
      "/test/project/.agent",
      "/test/home/.agent",
      path.join(repoRoot(), "config"),
    ],
  };
  return { ...base, ...overrides };
}

async function writeFile(p: string, content: string) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content, "utf-8");
}

function extractSpawnAgentBody(prompt: string): string {
  const patterns = [
    /<tool name="spawnAgent">\n([\s\S]*?)\n<\/tool>/,
    /<spawnAgent>\n([\s\S]*?)\n<\/spawnAgent>/,
    /### spawnAgent\n([\s\S]*?)(?=\n### notebookEdit\b)/,
  ];

  for (const pattern of patterns) {
    const match = prompt.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }

  throw new Error("spawnAgent section not found");
}

function expectedSpawnAgentRoleCatalog(): string {
  return [
    "Available child-agent roles:",
    ...buildSpawnAgentRolePromptLines(),
  ].join("\n");
}

function expectedSpawnAgentSharedGuidance(): string {
  return [
    SPAWN_AGENT_PROMPT_OVERVIEW,
    "",
    "When to use:",
    ...SPAWN_AGENT_WHEN_TO_USE.map((item) => `- **${item.label}**: ${item.description}`),
    "",
    "Orchestration rules:",
    ...SPAWN_AGENT_ORCHESTRATION_RULES.map((rule) => `- ${rule}`),
    "",
    "Coordinator rules:",
    ...SPAWN_AGENT_COORDINATION_RULES.map((rule) => `- ${rule}`),
    "",
    "Model override guidance:",
    ...SPAWN_AGENT_MODEL_OVERRIDE_GUIDANCE.map((rule) => `- ${rule}`),
  ].join("\n");
}

function extractSpawnAgentRoleCatalog(prompt: string): string {
  const body = extractSpawnAgentBody(prompt);
  const match = body.match(
    /Available child-agent roles:\n([\s\S]*?)(?=\n\n(?:Available allowed child target refs for this workspace:|Available model overrides for the current provider \(|$))/
  );

  if (!match?.[1]) {
    throw new Error("spawnAgent role catalog not found");
  }

  return `Available child-agent roles:\n${match[1].trimEnd()}`;
}

async function withMockedFetch<T>(
  fetchImpl: typeof fetch,
  run: () => Promise<T>,
): Promise<T> {
  const previous = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await run();
  } finally {
    globalThis.fetch = previous;
  }
}

function skillDoc(name: string, description: string, body = "# Skill Body\n"): string {
  return ["---", `name: \"${name}\"`, `description: \"${description}\"`, "---", "", body].join("\n");
}

function expectWorkspaceHygieneAndShellFirstGuidance(prompt: string) {
  expect(prompt).toContain(
    "Do not create generic `/tmp`, `tmp`, `temp`, `output`, `outputs`, `scratch`"
  );
  expect(prompt).toContain(
    "prefer the smallest shell-first path before creating a helper script"
  );
  expect(prompt).toContain("Only create an ad hoc Python or shell script");
}

function expectNoWorkspacePackageScaffoldingGuidance(prompt: string) {
  expect(prompt).toContain(
    "Do not create `package.json`, `package-lock.json`, `bun.lock`, `yarn.lock`, `pnpm-lock.yaml`, or `node_modules`"
  );
  expect(prompt).toContain("stage them outside the user's deliverable folder");
}

function expectWindowsShellGuidance(prompt: string) {
  expect(prompt).toContain("## Shell Execution Policy");
  expect(prompt).toContain("the `bash` tool actually runs PowerShell");
  expect(prompt).toContain("do not rely on `&&`, `export`, or `source`");
  expect(prompt).toContain("prefer `py -3` or `python`");
}

function expectImageInspectionGuidance(prompt: string) {
  const normalized = prompt.toLowerCase();
  const hasReadImageGuidance =
    normalized.includes("if read returns an image, inspect that image directly") ||
    normalized.includes("if read returns an image, inspect it directly") ||
    normalized.includes("if this tool returns an image, inspect it directly");

  expect(hasReadImageGuidance).toBe(true);
  expect(normalized).toContain("do not ask the user to re-upload it just because it is visual");
  expect(normalized).toContain("if the url points directly to an image, webfetch may save it into");
  expect(normalized).toContain("use `read` on the downloaded path to inspect it visually");
  expect(normalized).toContain("download a direct image url and inspect it with `read`");
}

function expectWebFetchDownloadGuidance(prompt: string) {
  const normalized = prompt.toLowerCase();
  expect(normalized).toContain("file downloaded");
  expect(normalized).toContain("downloads");
  expect(normalized).toContain("image");
  expect(normalized).toContain("pdf");
  expect(normalized).toContain("markdown");
}

function expectSharedAgentReportContract(prompt: string) {
  expect(prompt).toContain("Completion contract:");
  expect(prompt).toContain("exactly one `<agent_report>...</agent_report>` footer");
  expect(prompt).toContain("Required footer fields: `status`, `summary`.");
  expect(prompt).toContain("Optional footer fields: `filesChanged`, `filesRead`, `verification`, `residualRisks`.");
  expect(prompt).toContain("`status` must be one of `completed`, `blocked`, or `failed`.");
}

function expectCoordinatorRoleMappingGuidance(prompt: string) {
  expect(prompt).toContain("choose a read-only discovery role from the available sub-agent types");
  expect(prompt).toContain("choose a write-capable implementation role from the available sub-agent types");
  expect(prompt).toContain("choose an independent read-only verification role from the available sub-agent types");
  expect(prompt).toContain("Use role discipline based on the currently available sub-agent types:");
  expect(prompt).toContain("default: `explorer`");
  expect(prompt).toContain("default: `worker`");
  expect(prompt).toContain("default: `reviewer`");
  expect(prompt).toContain("spawn an independent read-only verification child (default: `reviewer`)");

  for (const role of Object.values(AGENT_ROLE_DEFINITIONS)) {
    expect(prompt).toContain(`- \`${role.id}\`: ${role.description}`);
  }
}

const IMAGE_GUIDANCE_PROMPT_CONFIGS = [
  { provider: "opencode-go", model: "kimi-k2.5", preferredChildModel: "kimi-k2.5" },
  { provider: "openai", model: "gpt-5.2", preferredChildModel: "gpt-5.2" },
  { provider: "anthropic", model: "claude-haiku-4-5", preferredChildModel: "claude-haiku-4-5" },
  { provider: "anthropic", model: "claude-sonnet-4-6", preferredChildModel: "claude-sonnet-4-6" },
  { provider: "anthropic", model: "claude-opus-4-6", preferredChildModel: "claude-opus-4-6" },
  { provider: "google", model: "gemini-3-flash-preview", preferredChildModel: "gemini-3-flash-preview" },
  { provider: "google", model: "gemini-3.1-pro-preview", preferredChildModel: "gemini-3.1-pro-preview" },
] as const;

const WEBFETCH_DOWNLOAD_GUIDANCE_PROMPT_CONFIGS = [
  ...IMAGE_GUIDANCE_PROMPT_CONFIGS,
] as const;

// ---------------------------------------------------------------------------
// loadSystemPrompt
// ---------------------------------------------------------------------------
describe("loadSystemPrompt", () => {
  test("loads system.md from builtInDir/prompts/", async () => {
    const config = makeConfig();
    const prompt = await loadSystemPrompt(config);
    expect(prompt).toBeDefined();
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(100);
  });

  test("replaces {{workingDirectory}} template variable", async () => {
    const config = makeConfig({ workingDirectory: "/my/custom/working/dir" });
    const prompt = await loadSystemPrompt(config);
    expect(prompt).toContain("/my/custom/working/dir");
    expect(prompt).not.toContain("{{workingDirectory}}");
  });

  test("does not surface outputDirectory when templates don't reference it", async () => {
    const config = makeConfig({ outputDirectory: "/my/custom/output/dir" });
    const prompt = await loadSystemPrompt(config);
    expect(prompt).not.toContain("{{outputDirectory}}");
    expect(prompt).not.toContain("/my/custom/output/dir");
  });

  test("uploadsDirectory no longer appears in prompt (uploads go to workingDirectory)", async () => {
    const config = makeConfig({ uploadsDirectory: "/my/custom/uploads/dir" });
    const prompt = await loadSystemPrompt(config);
    // uploadsDirectory is no longer referenced in the prompt template
    expect(prompt).not.toContain("{{uploadsDirectory}}");
    expect(prompt).not.toContain("/my/custom/uploads/dir");
  });

  test("replaces {{modelName}} template variable", async () => {
    const config = makeConfig({ provider: "openai", model: "gpt-5.4", preferredChildModel: "gpt-5.4" });
    const prompt = await loadSystemPrompt(config);
    expect(prompt).toContain("GPT-5.4");
    expect(prompt).not.toContain("{{modelName}}");
  });

  test("falls back to the generic system prompt for dynamic LM Studio models", async () => {
    const config = makeConfig({
      provider: "lmstudio",
      model: "local/qwen-2.5",
      preferredChildModel: "local/qwen-2.5",
      knowledgeCutoff: "Unknown",
    });

    const prompt = await withMockedFetch(
      (async () => {
        throw new Error("connect ECONNREFUSED");
      }) as typeof fetch,
      async () => await loadSystemPrompt(config),
    );

    expect(prompt).toContain("local/qwen-2.5");
    expect(prompt).toContain("Available model overrides for the current provider (LM Studio):");
    expect(prompt).toContain("Any LM Studio LLM key discovered at runtime is allowed.");
  });

  test("renders spawnAgent role catalog from AGENT_ROLE_DEFINITIONS across prompt formats", async () => {
    const expectedRoleCatalog = expectedSpawnAgentRoleCatalog();
    const expectedSharedGuidance = `${expectedSpawnAgentSharedGuidance()}\n\n${expectedRoleCatalog}`;
    const promptConfigs = [
      makeConfig({ provider: "openai", model: "gpt-5.4", preferredChildModel: "gpt-5.4" }),
      makeConfig({ provider: "google", model: "gemini-3.1-pro-preview", preferredChildModel: "gemini-3.1-pro-preview" }),
      makeConfig({ provider: "anthropic", model: "claude-sonnet-4-6", preferredChildModel: "claude-sonnet-4-6" }),
    ];

    expect(buildSpawnAgentRolePromptLines()).toHaveLength(Object.keys(AGENT_ROLE_DEFINITIONS).length);

    for (const config of promptConfigs) {
      const prompt = await loadSystemPrompt(config);
      const spawnAgentBody = extractSpawnAgentBody(prompt);

      expect(spawnAgentBody.startsWith(expectedSharedGuidance)).toBe(true);
      expect(extractSpawnAgentRoleCatalog(prompt)).toBe(expectedRoleCatalog);
      expect(spawnAgentBody).not.toContain("**explore**:");
      expect(spawnAgentBody).not.toContain("**general**:");
    }
  });

  test("renders dynamic spawnAgent model guidance for the current provider", async () => {
    const config = makeConfig({ provider: "openai", model: "gpt-5.4", preferredChildModel: "gpt-5.4" });
    const prompt = await loadSystemPrompt(config);
    const spawnAgentBody = extractSpawnAgentBody(prompt);

    expect(spawnAgentBody).toContain("Orchestration rules:");
    expect(spawnAgentBody).toContain("Coordinator rules:");
    expect(spawnAgentBody).toContain("Use multiple child agents in parallel when research tasks are independent.");
    expect(spawnAgentBody).toContain("report only what was launched; do not predict their results.");
    expect(spawnAgentBody).toContain("run an independent read-only verifier role for validation");
    expect(spawnAgentBody).toContain("Model override guidance:");
    expect(spawnAgentBody).toContain("Available model overrides for the current provider (OpenAI):");
    expect(spawnAgentBody).toContain("**GPT-5.4** (`gpt-5.4`)");
    expect(spawnAgentBody).toContain("**GPT-5.4 Mini** (`gpt-5.4-mini`)");
    expect(spawnAgentBody).toContain("**GPT-5 Mini** (`gpt-5-mini`)");
    expect(spawnAgentBody).toContain("`preferredChildModelRef` is only a workspace/UI suggestion");
    expect(prompt).toContain("spawnAgent with `role: \"explorer\"`");
    expect(prompt).not.toContain("spawnAgent (explore type)");
    expect(spawnAgentBody).not.toContain("**explore**: Fast codebase exploration.");
    expect(spawnAgentBody).not.toContain("**general**: Full-capability agent for delegated tasks.");
    expect(prompt).not.toContain("moonshotai/Kimi-K2.5");
  });

  test("default prompt includes explicit explorer-worker-reviewer plan-mode mapping", async () => {
    const config = makeConfig({
      provider: "opencode-go",
      model: "kimi-k2.5",
      preferredChildModel: "kimi-k2.5",
    });
    const prompt = await loadSystemPrompt(config);

    expectCoordinatorRoleMappingGuidance(prompt);
    expect(prompt).toContain("After launching child agents, only report what was launched; do not report predicted results.");
    expect(prompt).toContain("Reuse a child when follow-up work has high context overlap.");
    expect(prompt).toContain("Keep at most one write-capable child per file area at a time");
  });

  test("does not list Baseten child models in the spawnAgent summary", async () => {
    const config = makeConfig({
      provider: "baseten",
      model: "moonshotai/Kimi-K2.5",
      preferredChildModel: "moonshotai/Kimi-K2.5",
    });
    const prompt = await loadSystemPrompt(config);

    expect(prompt).toContain("Available model overrides for the current provider (Baseten):");
    expect(prompt).toContain("No user-facing child model overrides are available for this provider.");
    expect(prompt).not.toContain("Nemotron 120B A12B");
    expect(prompt).not.toContain("moonshotai/Kimi-K2.5");
  });

  test("replaces {{userName}} template variable", async () => {
    const config = makeConfig({ userName: "DistinctUserName42" });
    const prompt = await loadSystemPrompt(config);
    expect(prompt).toContain("DistinctUserName42");
    expect(prompt).not.toContain("{{userName}}");
  });

  test("replaces {{userName}} with empty string when not set", async () => {
    const config = makeConfig({ userName: "" });
    const prompt = await loadSystemPrompt(config);
    // Should not contain the template variable
    expect(prompt).not.toContain("{{userName}}");
  });

  test("omits user identity/profile lines when userName and profile fields are empty", async () => {
    const config = makeConfig({
      userName: "",
      userProfile: {
        instructions: "",
        work: "",
        details: "",
      },
    });
    const prompt = await loadSystemPrompt(config);
    expect(prompt).not.toContain("User name:");
    expect(prompt).not.toContain("User profile work/job:");
    expect(prompt).not.toContain("User profile instructions:");
    expect(prompt).not.toContain("User profile details the agent should know:");
  });

  test("keeps user identity/profile lines when values are provided", async () => {
    const config = makeConfig({
      userName: "Casey",
      userProfile: {
        instructions: "Keep answers concise.",
        work: "Engineering manager",
        details: "Prefers bullet points",
      },
    });
    const prompt = await loadSystemPrompt(config);
    expect(prompt).toContain("- User name: Casey");
    expect(prompt).toContain("- User profile work/job: Engineering manager");
    expect(prompt).toContain("- User profile instructions: Keep answers concise.");
    expect(prompt).toContain("- User profile details the agent should know: Prefers bullet points");
  });

  test("treats dollar sequences in user profile fields as literal text", async () => {
    const config = makeConfig({
      userName: "$&",
      userProfile: {
        work: "Shell user with $1 placeholders",
      },
    });
    const prompt = await loadSystemPrompt(config);

    expect(prompt).toContain("- User name: $&");
    expect(prompt).toContain("- User profile work/job: Shell user with $1 placeholders");
    expect(prompt).not.toContain("- User name: {{userName}}");
  });

  test("does not expand template-looking text inside user profile fields", async () => {
    const config = makeConfig({
      userProfile: {
        details: "Literal token {{workingDirectory}} should stay as written.",
      },
    });
    const prompt = await loadSystemPrompt(config);

    expect(prompt).toContain(
      "- User profile details the agent should know: Literal token {{workingDirectory}} should stay as written."
    );
    expect(prompt).toContain("/test/working");
  });

  test("replaces {{currentDate}} template variable", async () => {
    const config = makeConfig();
    const prompt = await loadSystemPrompt(config);
    expect(prompt).not.toContain("{{currentDate}}");
    // The date should be a readable string like "Friday, February 7, 2026"
    const today = new Date();
    const yearStr = today.getFullYear().toString();
    expect(prompt).toContain(yearStr);
  });

  test("replaces {{currentYear}} template variable", async () => {
    const config = makeConfig();
    const prompt = await loadSystemPrompt(config);
    expect(prompt).not.toContain("{{currentYear}}");
    const year = new Date().getFullYear().toString();
    expect(prompt).toContain(year);
  });

  test("replaces {{knowledgeCutoff}} template variable", async () => {
    const config = makeConfig({ knowledgeCutoff: "UniqueKnowledgeCutoff2099" });
    const prompt = await loadSystemPrompt(config);
    expect(prompt).toContain("January 2025");
    expect(prompt).not.toContain("{{knowledgeCutoff}}");
  });

  test("replaces {{skillsDirectory}} template variable if present in template", async () => {
    const config = makeConfig();
    const prompt = await loadSystemPrompt(config);
    // The template variable should not remain unreplaced
    expect(prompt).not.toContain("{{skillsDirectory}}");
  });

  test("no unreplaced template variables remain", async () => {
    const config = makeConfig();
    const prompt = await loadSystemPrompt(config);
    // Check that no {{...}} patterns remain
    const unreplaced = prompt.match(/\{\{[a-zA-Z]+\}\}/g);
    expect(unreplaced).toBeNull();
  });

  test("uses model-specific system template for gpt-5.2 when present", async () => {
    const { builtIn } = await makeTmpDirs();

    await writeFile(
      path.join(builtIn, "prompts", "system.md"),
      "DEFAULT SYSTEM TEMPLATE {{modelName}}"
    );
    await writeFile(
      path.join(builtIn, "prompts", "system-models", "gpt-5.2.md"),
      "GPT-5.2 SYSTEM TEMPLATE {{modelName}}"
    );

    const config = makeConfig({
      builtInDir: builtIn,
      provider: "openai",
      model: "gpt-5.2",
      skillsDirs: ["/nonexistent/skills"],
    });
    const prompt = await loadSystemPrompt(config);

    expect(prompt).toContain("GPT-5.2 SYSTEM TEMPLATE GPT-5.2");
    expect(prompt).not.toContain("DEFAULT SYSTEM TEMPLATE");
  });

  test("uses model-specific system template for gpt-5.4 when present", async () => {
    const { builtIn } = await makeTmpDirs();

    await writeFile(
      path.join(builtIn, "prompts", "system.md"),
      "DEFAULT SYSTEM TEMPLATE {{modelName}}"
    );
    await writeFile(
      path.join(builtIn, "prompts", "system-models", "gpt-5.4.json"),
      JSON.stringify({
        extends: "../system.md",
        replacements: [{
          old: "DEFAULT SYSTEM TEMPLATE {{modelName}}",
          new: "GPT-5.4 SYSTEM TEMPLATE {{modelName}}",
        }],
      }, null, 2),
    );

    const config = makeConfig({
      builtInDir: builtIn,
      provider: "openai",
      model: "gpt-5.4",
      skillsDirs: ["/nonexistent/skills"],
    });
    const prompt = await loadSystemPrompt(config);

    expect(prompt).toContain("GPT-5.4 SYSTEM TEMPLATE GPT-5.4");
    expect(prompt).not.toContain("DEFAULT SYSTEM TEMPLATE");
  });

  test("applies prompt template overlays when the base template uses CRLF newlines", async () => {
    const { builtIn } = await makeTmpDirs();

    await writeFile(
      path.join(builtIn, "prompts", "system.md"),
      "DEFAULT SYSTEM TEMPLATE\r\n{{modelName}}",
    );
    await writeFile(
      path.join(builtIn, "prompts", "system-models", "gpt-5.4.json"),
      JSON.stringify({
        extends: "../system.md",
        replacements: [{
          old: "DEFAULT SYSTEM TEMPLATE\n{{modelName}}",
          new: "GPT-5.4 SYSTEM TEMPLATE\n{{modelName}}",
        }],
      }, null, 2),
    );

    const prompt = await loadSystemPrompt(makeConfig({
      builtInDir: builtIn,
      provider: "openai",
      model: "gpt-5.4",
      skillsDirs: ["/nonexistent/skills"],
    }));

    expect(prompt).toContain("GPT-5.4 SYSTEM TEMPLATE\nGPT-5.4");
    expect(prompt).not.toContain("DEFAULT SYSTEM TEMPLATE");
  });

  test("uses the gpt-5.4 system template for gpt-5.4-mini", async () => {
    const { builtIn } = await makeTmpDirs();

    await writeFile(
      path.join(builtIn, "prompts", "system.md"),
      "DEFAULT SYSTEM TEMPLATE {{modelName}}"
    );
    await writeFile(
      path.join(builtIn, "prompts", "system-models", "gpt-5.4.json"),
      JSON.stringify({
        extends: "../system.md",
        replacements: [{
          old: "DEFAULT SYSTEM TEMPLATE {{modelName}}",
          new: "Base system prompt.\nMini marker.",
        }],
      }, null, 2),
    );

    const prompt = await loadSystemPrompt(
      makeConfig({
        builtInDir: builtIn,
        builtInConfigDir: path.join(builtIn, "config"),
        provider: "openai",
        model: "gpt-5.4-mini",
        preferredChildModel: "gpt-5.4-mini",
        skillsDirs: ["/nonexistent/skills"],
      }),
    );

    expect(prompt).toContain("Mini marker.");
    expect(prompt).not.toContain("DEFAULT SYSTEM TEMPLATE");
  });

  test("real gpt-5.4 prompt includes workspace hygiene and shell-first guidance", async () => {
    const config = makeConfig({
      provider: "openai",
      model: "gpt-5.4",
      skillsDirs: ["/nonexistent/skills"],
    });
    const prompt = await loadSystemPrompt(config);

    expectWorkspaceHygieneAndShellFirstGuidance(prompt);
    expectNoWorkspacePackageScaffoldingGuidance(prompt);
    expectImageInspectionGuidance(prompt);
    expectWebFetchDownloadGuidance(prompt);
    expect(prompt).toContain("prefer the native search/open/find tool");
    expect(prompt).toContain("unless provider-native citations already cover them");
    expect(prompt).toContain("Do not create extra staging files or helper folders");
  });

  test("real gpt-5.2 prompt includes workspace hygiene and shell-first guidance", async () => {
    const config = makeConfig({
      provider: "openai",
      model: "gpt-5.2",
      skillsDirs: ["/nonexistent/skills"],
    });
    const prompt = await loadSystemPrompt(config);

    expectWorkspaceHygieneAndShellFirstGuidance(prompt);
    expectNoWorkspacePackageScaffoldingGuidance(prompt);
    expectImageInspectionGuidance(prompt);
  });

  test("default system prompt includes workspace hygiene and shell-first guidance", async () => {
    const config = makeConfig({
      provider: "opencode-go",
      model: "kimi-k2.5",
      preferredChildModel: "kimi-k2.5",
      skillsDirs: ["/nonexistent/skills"],
    });
    const prompt = await loadSystemPrompt(config);

    expectWorkspaceHygieneAndShellFirstGuidance(prompt);
    expectNoWorkspacePackageScaffoldingGuidance(prompt);
    expectImageInspectionGuidance(prompt);
    expectWebFetchDownloadGuidance(prompt);
  });

  test("all shipped prompt templates that document read/webFetch include image inspection guidance", async () => {
    for (const overrides of IMAGE_GUIDANCE_PROMPT_CONFIGS) {
      const prompt = await loadSystemPrompt(makeConfig({
        ...overrides,
        skillsDirs: ["/nonexistent/skills"],
      }));
      expectImageInspectionGuidance(prompt);
    }
  });

  test("all shipped prompt templates that document webFetch include download guidance", async () => {
    for (const overrides of WEBFETCH_DOWNLOAD_GUIDANCE_PROMPT_CONFIGS) {
      const prompt = await loadSystemPrompt(makeConfig({
        ...overrides,
        skillsDirs: ["/nonexistent/skills"],
      }));
      expectWebFetchDownloadGuidance(prompt);
    }
  });

  test("uses model-specific system template for gemini-3.1-pro-preview when present", async () => {
    const { builtIn } = await makeTmpDirs();

    await writeFile(path.join(builtIn, "prompts", "system.md"), "DEFAULT {{modelName}}");
    await writeFile(
      path.join(builtIn, "prompts", "system-models", "gemini-3.1-pro-preview.md"),
      "GEMINI 3.1 PRO TEMPLATE {{modelName}}"
    );

    const config = makeConfig({
      builtInDir: builtIn,
      provider: "google",
      model: "gemini-3.1-pro-preview",
      skillsDirs: ["/nonexistent/skills"],
    });
    const prompt = await loadSystemPrompt(config);

    expect(prompt).toContain("GEMINI 3.1 PRO TEMPLATE Gemini 3.1 Pro Preview");
    expect(prompt).not.toContain("DEFAULT");
  });

  test("uses model-specific system template for Anthropic Opus", async () => {
    const { builtIn } = await makeTmpDirs();

    await writeFile(path.join(builtIn, "prompts", "system.md"), "DEFAULT {{modelName}}");
    await writeFile(
      path.join(builtIn, "prompts", "system-models", "claude-opus-4-6.json"),
      JSON.stringify({
        extends: "../system.md",
        replacements: [{
          old: "DEFAULT {{modelName}}",
          new: "OPUS TEMPLATE {{modelName}}",
        }],
      }, null, 2),
    );

    const config = makeConfig({
      builtInDir: builtIn,
      provider: "anthropic",
      model: "claude-opus-4-6",
      skillsDirs: ["/nonexistent/skills"],
    });
    const prompt = await loadSystemPrompt(config);

    expect(prompt).toContain("OPUS TEMPLATE Claude Opus 4.6");
    expect(prompt).not.toContain("DEFAULT");
  });

  test("uses model-specific system template for Claude 4.6 Sonnet", async () => {
    const { builtIn } = await makeTmpDirs();

    await writeFile(path.join(builtIn, "prompts", "system.md"), "DEFAULT {{modelName}}");
    await writeFile(
      path.join(builtIn, "prompts", "system-models", "claude-sonnet-4-6.md"),
      "SONNET TEMPLATE {{modelName}}"
    );

    const config = makeConfig({
      builtInDir: builtIn,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      skillsDirs: ["/nonexistent/skills"],
    });
    const prompt = await loadSystemPrompt(config);

    expect(prompt).toContain("SONNET TEMPLATE Claude Sonnet 4.6");
    expect(prompt).not.toContain("DEFAULT");
  });

  test("real Claude Haiku 4.5 prompt keeps its speed-focused guidance", async () => {
    const prompt = await loadSystemPrompt(makeConfig({
      provider: "anthropic",
      model: "claude-haiku-4-5",
      preferredChildModel: "claude-haiku-4-5",
      skillsDirs: ["/nonexistent/skills"],
    }));

    expect(prompt).toContain("You prioritize speed and conciseness while maintaining accuracy.");
    expect(prompt).toContain("<thinking_process>");
    expect(prompt).toContain("Use XML tags in your output when producing structured results");
    expect(prompt).not.toContain("<opus_reasoning>");
  });

  test("falls back to default system template when model template is missing", async () => {
    const { builtIn } = await makeTmpDirs();
    await writeFile(path.join(builtIn, "prompts", "system.md"), "DEFAULT TEMPLATE {{modelName}}");

    const config = makeConfig({
      builtInDir: builtIn,
      provider: "openai",
      model: "gpt-5.2",
      skillsDirs: ["/nonexistent/skills"],
    });
    const prompt = await loadSystemPrompt(config);

    expect(prompt).toContain("DEFAULT TEMPLATE GPT-5.2");
  });

  test("strips image guidance for non-multimodal models", async () => {
    const config = makeConfig({
      provider: "opencode-go",
      model: "glm-5",
      preferredChildModel: "glm-5",
      skillsDirs: ["/nonexistent/skills"],
    });
    const prompt = await loadSystemPrompt(config);
    const normalized = prompt.toLowerCase();

    expect(normalized).not.toContain("if read returns an image");
    expect(normalized).not.toContain("download a direct image url and inspect it with `read`");
    expect(normalized).not.toContain("do not ask the user to re-upload it just because it is visual");
  });

  test("always appends strict skill loading policy", async () => {
    const config = makeConfig({
      skillsDirs: ["/nonexistent/skills"],
    });
    const prompt = await loadSystemPrompt(config);
    expect(prompt).toContain("## Skill Loading Policy (Strict)");
    expect(prompt).toContain("call the `skill` tool first");
    expect(prompt).toContain("Do not count search result pages");
    expect(prompt).toContain("`python-pptx`");
    expect(prompt).toContain("Placeholder, stock stand-ins, or unrelated fallback images");
  });

  test("always appends Windows shell guidance and removes hardcoded && advice", async () => {
    const config = makeConfig({
      provider: "openai",
      model: "gpt-5.4",
      skillsDirs: ["/nonexistent/skills"],
    });
    const prompt = await loadSystemPrompt(config);
    expectWindowsShellGuidance(prompt);
    expect(prompt).not.toContain("chain them with && in a single bash call");
  });

  test("appends skills section when skills are found", async () => {
    const { tmp } = await makeTmpDirs();
    const skillsDir = path.join(tmp, "test-skills");

    // Create a skill directory with SKILL.md
    const skillMdPath = path.join(skillsDir, "test-skill", "SKILL.md");
    await writeFile(skillMdPath, skillDoc("test-skill", "Test Skill Description", "# Test Skill\n"));

    const config = makeConfig({
      skillsDirs: [skillsDir],
    });

    const prompt = await loadSystemPrompt(config);
    expect(prompt).toContain("## Available Skills");
    expect(prompt).toContain("test-skill");
    expect(prompt).toContain("Test Skill Description");
    expect(prompt).toContain("triggers: test-skill");
    expect(prompt).toContain(path.join("test-skill", "SKILL.md"));
  });

  test("appends multiple skills when multiple skill dirs exist", async () => {
    const { tmp } = await makeTmpDirs();
    const skillsDir = path.join(tmp, "multi-skills");

    await writeFile(
      path.join(skillsDir, "skill-a", "SKILL.md"),
      skillDoc("skill-a", "Skill A Description", "# Skill A\n")
    );

    await writeFile(
      path.join(skillsDir, "skill-b", "SKILL.md"),
      skillDoc("skill-b", "Skill B Description", "# Skill B\n")
    );

    const config = makeConfig({
      skillsDirs: [skillsDir],
    });

    const prompt = await loadSystemPrompt(config);
    expect(prompt).toContain("skill-a");
    expect(prompt).toContain("Skill A Description");
    expect(prompt).toContain("skill-b");
    expect(prompt).toContain("Skill B Description");
  });

  test("skips skills section when no skills are discovered", async () => {
    const { tmp } = await makeTmpDirs();
    // Empty skills directory - no skill subdirectories
    const emptySkillsDir = path.join(tmp, "empty-skills");
    await fs.mkdir(emptySkillsDir, { recursive: true });

    const config = makeConfig({
      skillsDirs: [emptySkillsDir],
    });

    const prompt = await loadSystemPrompt(config);
    expect(prompt).not.toContain("## Available Skills");
  });

  test("includes built-in slides in the prompt and discovered skills when earlier skill dirs are empty", async () => {
    const { tmp } = await makeTmpDirs();
    const projectSkills = path.join(tmp, "project-skills");
    const globalSkills = path.join(tmp, "global-skills");
    const userSkills = path.join(tmp, "user-skills");
    const builtInSkills = path.join(tmp, "built-in-skills");
    await fs.mkdir(projectSkills, { recursive: true });
    await fs.mkdir(globalSkills, { recursive: true });
    await fs.mkdir(userSkills, { recursive: true });
    await fs.mkdir(path.join(builtInSkills, "slides"), { recursive: true });
    await fs.writeFile(
      path.join(builtInSkills, "slides", "SKILL.md"),
      skillDoc("slides", "Built-in slides skill.", "# Slides\n"),
      "utf-8",
    );

    const config = makeConfig({
      skillsDirs: [projectSkills, globalSkills, userSkills, builtInSkills],
    });

    const { prompt, discoveredSkills } = await loadSystemPromptWithSkills(config);
    expect(prompt).toContain("## Available Skills");
    expect(prompt).toContain("**slides**");
    expect(prompt).toContain("source: built-in");
    expect(discoveredSkills.map((skill) => skill.name)).toContain("slides");
  });

  test("skips skills section when skills dirs do not exist", async () => {
    const config = makeConfig({
      skillsDirs: [
        "/nonexistent/path/skills1",
        "/nonexistent/path/skills2",
      ],
    });

    const prompt = await loadSystemPrompt(config);
    expect(prompt).not.toContain("## Available Skills");
  });

  test("appends hot cache (AGENT.md) when found in project dir", async () => {
    const { tmp } = await makeTmpDirs();
    const projectAgentDir = path.join(tmp, "project", ".agent");
    const userAgentDir = path.join(tmp, "home", ".agent");

    await writeFile(
      path.join(projectAgentDir, "AGENT.md"),
      "This is the project hot cache content."
    );

    const config = makeConfig({
      projectAgentDir,
      userAgentDir,
      skillsDirs: ["/nonexistent/skills"],
    });

    const prompt = await loadSystemPrompt(config);
    expect(prompt).toContain("## Memory");
    expect(prompt).toContain("### Loaded Hot Cache");
    expect(prompt).toContain("This is the project hot cache content.");
  });

  test("appends hot cache (AGENT.md) when found in user dir (fallback)", async () => {
    const { tmp } = await makeTmpDirs();
    const projectAgentDir = path.join(tmp, "project-no-cache", ".agent");
    const userAgentDir = path.join(tmp, "home", ".agent");

    // Only user dir has AGENT.md, not project dir
    await writeFile(
      path.join(userAgentDir, "AGENT.md"),
      "This is the user hot cache content."
    );

    const config = makeConfig({
      projectAgentDir,
      userAgentDir,
      skillsDirs: ["/nonexistent/skills"],
    });

    const prompt = await loadSystemPrompt(config);
    expect(prompt).toContain("## Memory");
    expect(prompt).toContain("### Loaded Hot Cache");
    expect(prompt).toContain("This is the user hot cache content.");
  });

  test("project AGENT.md takes priority over user AGENT.md", async () => {
    const { tmp } = await makeTmpDirs();
    const projectAgentDir = path.join(tmp, "project", ".agent");
    const userAgentDir = path.join(tmp, "home", ".agent");

    await writeFile(
      path.join(projectAgentDir, "AGENT.md"),
      "PROJECT cache wins."
    );

    await writeFile(
      path.join(userAgentDir, "AGENT.md"),
      "USER cache loses."
    );

    const config = makeConfig({
      projectAgentDir,
      userAgentDir,
      skillsDirs: ["/nonexistent/skills"],
    });

    const prompt = await loadSystemPrompt(config);
    expect(prompt).toContain("PROJECT cache wins.");
    expect(prompt).not.toContain("USER cache loses.");
  });

  test("does not inject deep memory entries into the startup prompt", async () => {
    const { tmp } = await makeTmpDirs();
    const projectAgentDir = path.join(tmp, "project", ".agent");
    const userAgentDir = path.join(tmp, "home", ".agent");

    await writeFile(path.join(projectAgentDir, "AGENT.md"), "Hot cache summary.");
    await writeFile(path.join(projectAgentDir, "memory", "people", "sarah.md"), "Sarah deep profile.");

    const config = makeConfig({
      projectAgentDir,
      userAgentDir,
      skillsDirs: ["/nonexistent/skills"],
    });

    const prompt = await loadSystemPrompt(config);
    expect(prompt).toContain("Hot cache summary.");
    expect(prompt).not.toContain("Sarah deep profile.");
  });

  test("skips hot cache section when no AGENT.md exists", async () => {
    const { tmp } = await makeTmpDirs();
    const projectAgentDir = path.join(tmp, "project-empty", ".agent");
    const userAgentDir = path.join(tmp, "home-empty", ".agent");

    const config = makeConfig({
      projectAgentDir,
      userAgentDir,
      skillsDirs: ["/nonexistent/skills"],
    });

    const prompt = await loadSystemPrompt(config);
    expect(prompt).not.toContain("## Memory");
  });

  test("removes memory guidance from the prompt when memory is disabled", async () => {
    const config = makeConfig({
      enableMemory: false,
      skillsDirs: ["/nonexistent/skills"],
    });

    const prompt = await loadSystemPrompt(config);
    expect(prompt).toContain("## Memory Disabled");
    expect(prompt).not.toContain("Lookup flow: AGENT.md");
    expect(prompt).not.toContain("Read, write, or search persistent memory");
  });

  test("skips hot cache section when AGENT.md is empty/whitespace", async () => {
    const { tmp } = await makeTmpDirs();
    const projectAgentDir = path.join(tmp, "project", ".agent");
    const userAgentDir = path.join(tmp, "home", ".agent");

    await writeFile(path.join(projectAgentDir, "AGENT.md"), "   \n  \n  ");

    const config = makeConfig({
      projectAgentDir,
      userAgentDir,
      skillsDirs: ["/nonexistent/skills"],
    });

    const prompt = await loadSystemPrompt(config);
    expect(prompt).not.toContain("## Memory");
  });

  test("uses real system.md from repo and all variables get replaced", async () => {
    const config = makeConfig();
    const prompt = await loadSystemPrompt(config);

    expect(prompt).toContain("<environment>");
    expect(prompt).toContain("<tools>");
    expect(prompt).toContain("Knowledge cutoff: January 2025");
  });

  test("skills section includes source annotation", async () => {
    const { tmp } = await makeTmpDirs();
    const skillsDir = path.join(tmp, "src-skills");

    await writeFile(
      path.join(skillsDir, "annotated-skill", "SKILL.md"),
      skillDoc("annotated-skill", "Annotated Skill", "# Annotated Skill\n")
    );

    const config = makeConfig({
      skillsDirs: [skillsDir],
    });

    const prompt = await loadSystemPrompt(config);
    expect(prompt).toContain("source: project");
  });

  test("skills section includes trigger annotations", async () => {
    const { tmp } = await makeTmpDirs();
    const skillsDir = path.join(tmp, "trigger-skills");

    await writeFile(
      path.join(skillsDir, "xlsx", "SKILL.md"),
      skillDoc("xlsx", "Excel Spreadsheet Skill", "# Excel Spreadsheet Skill\n")
    );

    const config = makeConfig({
      skillsDirs: [skillsDir],
    });

    const prompt = await loadSystemPrompt(config);
    // xlsx has default triggers: spreadsheet, excel, .xlsx, csv, data table, chart
    expect(prompt).toContain("spreadsheet");
    expect(prompt).toContain("excel");
  });
});

// ---------------------------------------------------------------------------
// loadSubAgentPrompt
// ---------------------------------------------------------------------------
describe("loadSubAgentPrompt", () => {
  test("loads explore prompt and returns non-empty string", async () => {
    const config = makeConfig();
    const prompt = await loadSubAgentPrompt(config, "explore");
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt).toContain("Role: explorer");
  });

  test("loads research prompt and returns non-empty string", async () => {
    const config = makeConfig();
    const prompt = await loadSubAgentPrompt(config, "research");
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt).toContain("research");
  });

  test("explore prompt is different from research prompt", async () => {
    const config = makeConfig();
    const explore = await loadSubAgentPrompt(config, "explore");
    const research = await loadSubAgentPrompt(config, "research");
    expect(explore).not.toBe(research);
  });

  test("loads general prompt and returns non-empty string", async () => {
    const config = makeConfig();
    const prompt = await loadSubAgentPrompt(config, "general");
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt).toContain("Role: worker");
  });

  test("worker prompt requires structured completion and parseable footer", async () => {
    const config = makeConfig();
    const prompt = await loadAgentPrompt(config, "worker");
    expectSharedAgentReportContract(prompt);
    expect(prompt).toContain("Own a narrow, explicitly assigned slice of work.");
    expect(prompt).toContain("Run the most relevant verification you can before finishing.");
    expect(prompt).toContain("Summary");
    expect(prompt).toContain("Files changed");
    expect(prompt).toContain("Verification");
    expect(prompt).toContain("Residual risks");
  });

  test("reviewer prompt requires read-only verification evidence, adversarial probe, and verdict", async () => {
    const config = makeConfig();
    const prompt = await loadAgentPrompt(config, "reviewer");
    expectSharedAgentReportContract(prompt);
    expect(prompt).toContain("Do not modify project files.");
    expect(prompt).toContain("Every PASS claim must include the command you ran and the observed output");
    expect(prompt).toContain("Run at least one adversarial probe");
    expect(prompt).toContain("VERDICT: PASS");
    expect(prompt).toContain("PASS -> `completed`, PARTIAL -> `blocked`, FAIL -> `failed`");
  });

  test("explorer prompt requires structured answer sections and parseable footer", async () => {
    const config = makeConfig();
    const prompt = await loadAgentPrompt(config, "explorer");
    expectSharedAgentReportContract(prompt);
    expect(prompt).toContain("Answer");
    expect(prompt).toContain("Evidence");
    expect(prompt).toContain("Important files");
    expect(prompt).toContain("Uncertainties / open questions");
  });

  test("default prompt inherits the shared parseable footer contract", async () => {
    const config = makeConfig();
    const prompt = await loadAgentPrompt(config, "default");
    expectSharedAgentReportContract(prompt);
    expect(prompt).toContain("Role: default");
    expect(prompt).toContain("Stay bounded, execute directly when appropriate, and verify relevant claims before finishing.");
    expect(prompt).toContain("Summary");
    expect(prompt).toContain("Files changed");
    expect(prompt).toContain("Verification");
    expect(prompt).toContain("Residual risks");
  });

  test("loads from builtInDir/prompts/sub-agents/ path", async () => {
    const { builtIn } = await makeTmpDirs();

    const basePrompt = "Shared base prompt.";
    const promptContent = "Custom explore agent prompt for testing.";
    await writeFile(
      path.join(builtIn, "prompts", "sub-agents", "base.md"),
      basePrompt
    );
    await writeFile(
      path.join(builtIn, "prompts", "sub-agents", "explorer.md"),
      promptContent
    );

    const config = makeConfig({ builtInDir: builtIn });
    const prompt = await loadSubAgentPrompt(config, "explore");
    expect(prompt).toBe(`${basePrompt}\n\n${promptContent}\n`);
  });
});

// ---------------------------------------------------------------------------
// loadHotCache (tested indirectly through loadSystemPrompt)
// ---------------------------------------------------------------------------
describe("loadHotCache (tested indirectly)", () => {
  test("returns AGENT.md content from project dir", async () => {
    const { tmp } = await makeTmpDirs();
    const projectAgentDir = path.join(tmp, "project", ".agent");
    const userAgentDir = path.join(tmp, "home", ".agent");

    await writeFile(
      path.join(projectAgentDir, "AGENT.md"),
      "Project-level memory content here."
    );

    const config = makeConfig({
      projectAgentDir,
      userAgentDir,
      skillsDirs: ["/nonexistent/skills"],
    });

    const prompt = await loadSystemPrompt(config);
    expect(prompt).toContain("Project-level memory content here.");
  });

  test("falls back to user dir when project dir has no AGENT.md", async () => {
    const { tmp } = await makeTmpDirs();
    const projectAgentDir = path.join(tmp, "no-project", ".agent");
    const userAgentDir = path.join(tmp, "home", ".agent");

    await writeFile(
      path.join(userAgentDir, "AGENT.md"),
      "User-level memory fallback content."
    );

    const config = makeConfig({
      projectAgentDir,
      userAgentDir,
      skillsDirs: ["/nonexistent/skills"],
    });

    const prompt = await loadSystemPrompt(config);
    expect(prompt).toContain("User-level memory fallback content.");
  });

  test("returns empty when no AGENT.md exists anywhere", async () => {
    const { tmp } = await makeTmpDirs();
    const projectAgentDir = path.join(tmp, "empty-project", ".agent");
    const userAgentDir = path.join(tmp, "empty-home", ".agent");

    const config = makeConfig({
      projectAgentDir,
      userAgentDir,
      skillsDirs: ["/nonexistent/skills"],
    });

    const prompt = await loadSystemPrompt(config);
    // No memory section should be appended
    expect(prompt).not.toContain("## Memory");
  });

  test("skips memory injection when the memory database is corrupt", async () => {
    const { tmp } = await makeTmpDirs();
    const projectAgentDir = path.join(tmp, "corrupt-project", ".agent");
    const userAgentDir = path.join(tmp, "corrupt-home", ".agent");

    await writeFile(path.join(projectAgentDir, "memory.sqlite"), "not a sqlite db");

    const config = makeConfig({
      projectAgentDir,
      userAgentDir,
      skillsDirs: ["/nonexistent/skills"],
    });

    const prompt = await loadSystemPrompt(config);
    expect(prompt).toContain("<environment>");
    expect(prompt).not.toContain("## Memory");
  });

  test("AGENT.md with rich markdown content is preserved", async () => {
    const { tmp } = await makeTmpDirs();
    const projectAgentDir = path.join(tmp, "rich-project", ".agent");
    const userAgentDir = path.join(tmp, "rich-home", ".agent");

    const richContent = [
      "# Project Notes",
      "",
      "## Key Contacts",
      "- Alice: alice@example.com (PM)",
      "- Bob: bob@example.com (Lead)",
      "",
      "## Acronyms",
      "- API: Application Programming Interface",
      "- CI: Continuous Integration",
    ].join("\n");

    await writeFile(path.join(projectAgentDir, "AGENT.md"), richContent);

    const config = makeConfig({
      projectAgentDir,
      userAgentDir,
      skillsDirs: ["/nonexistent/skills"],
    });

    const prompt = await loadSystemPrompt(config);
    expect(prompt).toContain("# Project Notes");
    expect(prompt).toContain("alice@example.com");
    expect(prompt).toContain("CI: Continuous Integration");
  });

  test("hot cache combined with skills in same prompt", async () => {
    const { tmp } = await makeTmpDirs();
    const projectAgentDir = path.join(tmp, "combo-project", ".agent");
    const userAgentDir = path.join(tmp, "combo-home", ".agent");
    const skillsDir = path.join(tmp, "combo-skills");

    await writeFile(
      path.join(projectAgentDir, "AGENT.md"),
      "Hot cache content present."
    );

    await writeFile(
      path.join(skillsDir, "combo-skill", "SKILL.md"),
      skillDoc("combo-skill", "Combo Skill", "# Combo Skill\n")
    );

    const config = makeConfig({
      projectAgentDir,
      userAgentDir,
      skillsDirs: [skillsDir],
    });

    const prompt = await loadSystemPrompt(config);

    expect(prompt).toContain("## Memory");
    expect(prompt).toContain("### Loaded Hot Cache");
    expect(prompt).toContain("Hot cache content present.");
  });
});
