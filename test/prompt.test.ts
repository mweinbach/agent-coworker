import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadSystemPrompt, loadSubAgentPrompt, loadSystemPromptWithSkills } from "../src/prompt";
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
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

const IMAGE_GUIDANCE_PROMPT_FILES = [
  "prompts/system.md",
  "prompts/system-models/gpt-5.2.md",
  "prompts/system-models/gpt-5.2.md",
  "prompts/system-models/claude-haiku-4-5.md",
  "prompts/system-models/claude-sonnet-4-6.md",
  "prompts/system-models/claude-opus-4-6.md",
  "prompts/system-models/gemini-3-flash-preview.md",
  "prompts/system-models/gemini-3.1-pro-preview.md",
] as const;

const WEBFETCH_DOWNLOAD_GUIDANCE_PROMPT_FILES = [
  ...IMAGE_GUIDANCE_PROMPT_FILES,
  "prompts/system-models/gemini-3.1-pro-preview.md",
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

  test("preserves image guidance for discovered AWS Bedrock Proxy vision models", async () => {
    const config = makeConfig({
      provider: "aws-bedrock-proxy",
      model: "vision-router",
      preferredChildModel: "vision-router",
      knowledgeCutoff: "Unknown",
      providerOptions: {
        "aws-bedrock-proxy": {
          baseUrl: "https://proxy.example.com/v1",
        },
      },
    });

    const prompt = await withMockedFetch(
      (async () => jsonResponse({
        object: "list",
        data: [
          { id: "vision-router", object: "model", modalities: ["text", "image"] },
        ],
      })) as typeof fetch,
      async () => await loadSystemPrompt(config),
    );

    expectImageInspectionGuidance(prompt);
  });

  test("preserves image guidance for AWS Bedrock Proxy vision models when base URL is only in global config fields", async () => {
    const config = makeConfig({
      provider: "aws-bedrock-proxy",
      model: "vision-router",
      preferredChildModel: "vision-router",
      knowledgeCutoff: "Unknown",
      awsBedrockProxyBaseUrl: "https://proxy.global.example.com/v1",
    });

    const prompt = await withMockedFetch(
      (async () => jsonResponse({
        object: "list",
        data: [
          { id: "vision-router", object: "model", modalities: ["text", "image"] },
        ],
      })) as typeof fetch,
      async () => await loadSystemPrompt(config),
    );

    expectImageInspectionGuidance(prompt);
  });

  test("renders dynamic spawnAgent roles and current-provider model guidance", async () => {
    const config = makeConfig({ provider: "openai", model: "gpt-5.4", preferredChildModel: "gpt-5.4" });
    const prompt = await loadSystemPrompt(config);

    expect(prompt).toContain("Available child-agent roles:");
    expect(prompt).toContain("**default**");
    expect(prompt).toContain("**explorer**");
    expect(prompt).toContain("**research**");
    expect(prompt).toContain("**worker**");
    expect(prompt).toContain("**reviewer**");
    expect(prompt).toContain("Available model overrides for the current provider (OpenAI):");
    expect(prompt).toContain("**GPT-5.4** (`gpt-5.4`)");
    expect(prompt).toContain("**GPT-5.4 Mini** (`gpt-5.4-mini`)");
    expect(prompt).toContain("**GPT-5 Mini** (`gpt-5-mini`)");
    expect(prompt).toContain("`preferredChildModelRef` is only a workspace/UI suggestion");
    expect(prompt).toContain("spawnAgent with `role: \"explorer\"`");
    expect(prompt).not.toContain("spawnAgent (explore type)");
    expect(prompt).not.toContain("**explore**: Fast codebase exploration.");
    expect(prompt).not.toContain("**general**: Full-capability agent for delegated tasks.");
    expect(prompt).not.toContain("moonshotai/Kimi-K2.5");
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
      path.join(builtIn, "prompts", "system-models", "gpt-5.4.md"),
      "GPT-5.4 SYSTEM TEMPLATE {{modelName}}"
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

  test("uses the gpt-5.4 system template for gpt-5.4-mini", async () => {
    const { builtIn } = await makeTmpDirs();

    await writeFile(
      path.join(builtIn, "prompts", "system.md"),
      "DEFAULT SYSTEM TEMPLATE {{modelName}}"
    );
    await writeFile(
      path.join(builtIn, "prompts", "system-models", "gpt-5.4.md"),
      "Base system prompt.\nMini marker.",
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

  test("all shipped prompt files that document read/webFetch include image inspection guidance", async () => {
    for (const relPath of IMAGE_GUIDANCE_PROMPT_FILES) {
      const prompt = await fs.readFile(path.join(repoRoot(), relPath), "utf-8");
      expectImageInspectionGuidance(prompt);
    }
  });

  test("all shipped prompt files that document webFetch include download guidance", async () => {
    for (const relPath of WEBFETCH_DOWNLOAD_GUIDANCE_PROMPT_FILES) {
      const prompt = await fs.readFile(path.join(repoRoot(), relPath), "utf-8");
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
      path.join(builtIn, "prompts", "system-models", "claude-opus-4-6.md"),
      "OPUS TEMPLATE {{modelName}}"
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
