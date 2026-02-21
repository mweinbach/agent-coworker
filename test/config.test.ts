import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defaultModelForProvider, getModel, loadConfig } from "../src/config";
import { PROVIDER_MODEL_CATALOG } from "../src/providers";

function repoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..");
}

async function writeJson(p: string, obj: unknown) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(obj, null, 2), "utf-8");
}

async function makeTmpDirs() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-cfg-"));
  const cwd = path.join(tmp, "project");
  const home = path.join(tmp, "home");
  await fs.mkdir(cwd, { recursive: true });
  await fs.mkdir(home, { recursive: true });
  return { tmp, cwd, home };
}

// ---------------------------------------------------------------------------
// loadConfig
// ---------------------------------------------------------------------------
describe("loadConfig", () => {
  // ---- The two original tests ----

  test("defaults < user < project < env", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-coworker-"));
    const cwd = path.join(tmp, "project");
    const home = path.join(tmp, "home");

    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(home, { recursive: true });

    await writeJson(path.join(home, ".agent", "config.json"), {
      provider: "anthropic",
      model: "claude-test",
      outputDirectory: "user-output",
    });

    await writeJson(path.join(cwd, ".agent", "config.json"), {
      provider: "openai",
      model: "gpt-test",
      outputDirectory: "project-output",
    });

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: {},
    });

    expect(cfg.provider).toBe("openai");
    expect(cfg.model).toBe("gpt-test");
    expect(cfg.outputDirectory).toBe(path.join(cwd, "project-output"));

    const cfg2 = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: { AGENT_PROVIDER: "google", AGENT_MODEL: "gemini-test" },
    });

    expect(cfg2.provider).toBe("google");
    expect(cfg2.model).toBe("gemini-test");
  });

  test("provider override uses provider-default model when no model is set", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-coworker-"));
    const cwd = path.join(tmp, "project");
    const home = path.join(tmp, "home");

    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(home, { recursive: true });

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: { AGENT_PROVIDER: "openai" },
    });

    expect(cfg.provider).toBe("openai");
    expect(cfg.model).toBe("gpt-5.2");
  });

  // ---- New tests ----

  test("defaults loaded from built-in defaults.json", async () => {
    const { cwd, home } = await makeTmpDirs();

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: {},
    });

    expect(cfg.provider).toBe("google");
    expect(cfg.model).toBe(defaultModelForProvider("google"));
    expect(cfg.subAgentModel).toBe(defaultModelForProvider("google"));
    expect(cfg.knowledgeCutoff).toBe("End of May 2025");
    expect(cfg.userName).toBe("");
    expect(cfg.observabilityEnabled).toBe(true);
  });

  test("user config from homedir/.agent/config.json overrides defaults", async () => {
    const { cwd, home } = await makeTmpDirs();

    await writeJson(path.join(home, ".agent", "config.json"), {
      provider: "anthropic",
      model: "claude-custom",
      userName: "Alice",
    });

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: {},
    });

    expect(cfg.provider).toBe("anthropic");
    expect(cfg.model).toBe("claude-custom");
    expect(cfg.userName).toBe("Alice");
  });

  test("project config from cwd/.agent/config.json overrides user config", async () => {
    const { cwd, home } = await makeTmpDirs();

    await writeJson(path.join(home, ".agent", "config.json"), {
      provider: "anthropic",
      model: "claude-user",
      userName: "Alice",
    });

    await writeJson(path.join(cwd, ".agent", "config.json"), {
      provider: "openai",
      model: "gpt-project",
    });

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: {},
    });

    expect(cfg.provider).toBe("openai");
    expect(cfg.model).toBe("gpt-project");
    expect(cfg.userName).toBe("Alice");
  });

  test("AGENT_PROVIDER env var overrides all config files", async () => {
    const { cwd, home } = await makeTmpDirs();

    await writeJson(path.join(cwd, ".agent", "config.json"), {
      provider: "openai",
    });

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: { AGENT_PROVIDER: "anthropic" },
    });

    expect(cfg.provider).toBe("anthropic");
  });

  test("AGENT_MODEL env var overrides all config files", async () => {
    const { cwd, home } = await makeTmpDirs();

    await writeJson(path.join(cwd, ".agent", "config.json"), {
      model: "gpt-project",
    });

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: { AGENT_MODEL: "env-model-override" },
    });

    expect(cfg.model).toBe("env-model-override");
  });

  test("AGENT_WORKING_DIR env var overrides cwd", async () => {
    const { cwd, home } = await makeTmpDirs();
    const customDir = path.join(os.tmpdir(), "custom-working-dir");

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: { AGENT_WORKING_DIR: customDir },
    });

    expect(cfg.workingDirectory).toBe(customDir);
  });

  test("AGENT_OUTPUT_DIR env var overrides all output directory config", async () => {
    const { cwd, home } = await makeTmpDirs();

    await writeJson(path.join(cwd, ".agent", "config.json"), {
      outputDirectory: "project-out",
    });

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: { AGENT_OUTPUT_DIR: "/absolute/env-output" },
    });

    expect(cfg.outputDirectory).toBe("/absolute/env-output");
  });

  test("AGENT_UPLOADS_DIR env var overrides all uploads directory config", async () => {
    const { cwd, home } = await makeTmpDirs();

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: { AGENT_UPLOADS_DIR: "/tmp/env-uploads" },
    });

    expect(cfg.uploadsDirectory).toBe("/tmp/env-uploads");
  });

  test("AGENT_USER_NAME env var overrides all userName config", async () => {
    const { cwd, home } = await makeTmpDirs();

    await writeJson(path.join(home, ".agent", "config.json"), {
      userName: "Alice",
    });

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: { AGENT_USER_NAME: "EnvBob" },
    });

    expect(cfg.userName).toBe("EnvBob");
  });

  test("missing config files handled gracefully (no crash)", async () => {
    const { cwd, home } = await makeTmpDirs();

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: {},
    });

    expect(cfg.provider).toBe("google");
    expect(typeof cfg.model).toBe("string");
    expect(cfg.model.length).toBeGreaterThan(0);
  });

  test("completely missing builtInDir handled gracefully", async () => {
    const { cwd, home } = await makeTmpDirs();
    const fakeBuildIn = path.join(os.tmpdir(), "no-such-dir-" + Date.now());

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: fakeBuildIn,
      env: {},
    });

    expect(cfg.provider).toBe("google");
    expect(cfg.model).toBe(defaultModelForProvider("google"));
  });

  test("merge precedence across all three tiers for recognized fields", async () => {
    const { cwd, home } = await makeTmpDirs();

    // User sets knowledgeCutoff and userName
    await writeJson(path.join(home, ".agent", "config.json"), {
      knowledgeCutoff: "user-level-cutoff",
      userName: "UserName",
    });

    // Project only sets userName (should override user)
    await writeJson(path.join(cwd, ".agent", "config.json"), {
      userName: "ProjectName",
    });

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: {},
    });

    // Project overrides user for userName
    expect(cfg.userName).toBe("ProjectName");
    // User-level knowledgeCutoff preserved (not overridden by project)
    expect(cfg.knowledgeCutoff).toBe("user-level-cutoff");
    // Provider from built-in defaults (not overridden by user or project)
    expect(cfg.provider).toBe("google");
  });

  test("workingDirectory defaults to cwd when AGENT_WORKING_DIR not set", async () => {
    const { cwd, home } = await makeTmpDirs();

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: {},
    });

    expect(cfg.workingDirectory).toBe(cwd);
  });

  test("subAgentModel falls back to main model when not configured", async () => {
    const { cwd, home } = await makeTmpDirs();

    const customBuiltIn = path.join(os.tmpdir(), "builtin-nosub-" + Date.now());
    await writeJson(path.join(customBuiltIn, "config", "defaults.json"), {
      provider: "openai",
      model: "gpt-main",
    });

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: customBuiltIn,
      env: {},
    });

    expect(cfg.subAgentModel).toBe("gpt-main");
  });

  test("subAgentModel from project config overrides user config", async () => {
    const { cwd, home } = await makeTmpDirs();

    await writeJson(path.join(home, ".agent", "config.json"), {
      subAgentModel: "user-sub-model",
    });

    await writeJson(path.join(cwd, ".agent", "config.json"), {
      subAgentModel: "project-sub-model",
    });

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: {},
    });

    expect(cfg.subAgentModel).toBe("project-sub-model");
  });

  test("knowledgeCutoff from project config overrides user and defaults", async () => {
    const { cwd, home } = await makeTmpDirs();

    await writeJson(path.join(home, ".agent", "config.json"), {
      knowledgeCutoff: "User cutoff 2024",
    });

    await writeJson(path.join(cwd, ".agent", "config.json"), {
      knowledgeCutoff: "Project cutoff 2025",
    });

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: {},
    });

    expect(cfg.knowledgeCutoff).toBe("Project cutoff 2025");
  });

  test("invalid provider in config falls back to default", async () => {
    const { cwd, home } = await makeTmpDirs();

    await writeJson(path.join(cwd, ".agent", "config.json"), {
      provider: "invalid-provider",
    });

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: {},
    });

    expect(cfg.provider).toBe("google");
  });

  test("invalid provider in env falls through to config chain", async () => {
    const { cwd, home } = await makeTmpDirs();

    await writeJson(path.join(cwd, ".agent", "config.json"), {
      provider: "anthropic",
    });

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: { AGENT_PROVIDER: "not-a-real-provider" },
    });

    expect(cfg.provider).toBe("anthropic");
  });

  test("reads saved API key from legacy .ai-coworker connections file", async () => {
    const { cwd, home } = await makeTmpDirs();
    await writeJson(path.join(home, ".ai-coworker", "config", "connections.json"), {
      version: 1,
      updatedAt: new Date().toISOString(),
      services: {
        openai: {
          service: "openai",
          mode: "api_key",
          apiKey: "legacy-service-key",
          updatedAt: new Date().toISOString(),
        },
      },
    });

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: { AGENT_PROVIDER: "openai" },
    });

    const model = getModel(cfg) as any;
    const headers = await model.config.headers();
    expect(headers.authorization).toBe("Bearer legacy-service-key");
  });

  test("reads saved API key from legacy apiKeys shape", async () => {
    const { cwd, home } = await makeTmpDirs();
    await writeJson(path.join(home, ".cowork", "auth", "connections.json"), {
      apiKeys: {
        openai: "legacy-shape-key",
      },
    });

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: { AGENT_PROVIDER: "openai" },
    });

    const model = getModel(cfg) as any;
    const headers = await model.config.headers();
    expect(headers.authorization).toBe("Bearer legacy-shape-key");
  });

  test("loads command template config from merged config", async () => {
    const { cwd, home } = await makeTmpDirs();

    await writeJson(path.join(cwd, ".agent", "config.json"), {
      command: {
        triage: {
          description: "triage issues",
          source: "command",
          template: "Triage these issues: $ARGUMENTS",
        },
      },
    });

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: {},
    });

    expect(cfg.command).toBeDefined();
    expect(cfg.command?.triage?.description).toBe("triage issues");
    expect(cfg.command?.triage?.source).toBe("command");
    expect(cfg.command?.triage?.template).toBe("Triage these issues: $ARGUMENTS");
  });

  test("ignores invalid command template entries", async () => {
    const { cwd, home } = await makeTmpDirs();

    await writeJson(path.join(cwd, ".agent", "config.json"), {
      command: {
        bad1: { template: "" },
        bad2: { description: "missing template" },
      },
    });

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: {},
    });

    expect(cfg.command).toBeUndefined();
  });

  test("merges providerOptions from built-in, user, and project config", async () => {
    const { cwd, home } = await makeTmpDirs();
    const customBuiltIn = path.join(os.tmpdir(), `builtin-provider-options-${Date.now()}`);

    await writeJson(path.join(customBuiltIn, "config", "defaults.json"), {
      provider: "openai",
      model: "gpt-5.2",
      providerOptions: {
        openai: {
          reasoningEffort: "low",
          reasoningSummary: "auto",
        },
        google: {
          thinkingConfig: { includeThoughts: true, thinkingLevel: "low" },
        },
      },
    });

    await writeJson(path.join(home, ".agent", "config.json"), {
      providerOptions: {
        openai: {
          reasoningSummary: "detailed",
        },
      },
    });

    await writeJson(path.join(cwd, ".agent", "config.json"), {
      providerOptions: {
        openai: {
          reasoningEffort: "high",
        },
      },
    });

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: customBuiltIn,
      env: {},
    });

    expect(cfg.providerOptions).toBeDefined();
    expect(cfg.providerOptions?.openai.reasoningEffort).toBe("high");
    expect(cfg.providerOptions?.openai.reasoningSummary).toBe("detailed");
    expect(cfg.providerOptions?.google.thinkingConfig.thinkingLevel).toBe("low");
  });

  test("loads modelSettings maxRetries from config and allows env overrides", async () => {
    const { cwd, home } = await makeTmpDirs();

    await writeJson(path.join(cwd, ".agent", "config.json"), {
      modelSettings: {
        maxRetries: 4,
      },
    });

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: {
        AGENT_MODEL_MAX_RETRIES: "1",
      },
    });

    expect(cfg.modelSettings?.maxRetries).toBe(1);
  });

  test("loads Langfuse observability config from env vars", async () => {
    const { cwd, home } = await makeTmpDirs();

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: {
        AGENT_OBSERVABILITY_ENABLED: "true",
        LANGFUSE_PUBLIC_KEY: "pk-lf-test",
        LANGFUSE_SECRET_KEY: "sk-lf-test",
        LANGFUSE_BASE_URL: "https://self-hosted.langfuse.example/",
        LANGFUSE_TRACING_ENVIRONMENT: "staging",
        LANGFUSE_RELEASE: "release-123",
      },
    });

    expect(cfg.observabilityEnabled).toBe(true);
    expect(cfg.observability?.provider).toBe("langfuse");
    expect(cfg.observability?.baseUrl).toBe("https://self-hosted.langfuse.example");
    expect(cfg.observability?.otelEndpoint).toBe("https://self-hosted.langfuse.example/api/public/otel/v1/traces");
    expect(cfg.observability?.publicKey).toBe("pk-lf-test");
    expect(cfg.observability?.secretKey).toBe("sk-lf-test");
    expect(cfg.observability?.tracingEnvironment).toBe("staging");
    expect(cfg.observability?.release).toBe("release-123");
  });

  test("enabled observability remains non-fatal when Langfuse keys are missing", async () => {
    const { cwd, home } = await makeTmpDirs();

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: {
        AGENT_OBSERVABILITY_ENABLED: "true",
      },
    });

    expect(cfg.observabilityEnabled).toBe(true);
    expect(cfg.observability?.provider).toBe("langfuse");
    expect(cfg.observability?.publicKey).toBeUndefined();
    expect(cfg.observability?.secretKey).toBeUndefined();
  });

  test("explicit disable overrides Langfuse key presence", async () => {
    const { cwd, home } = await makeTmpDirs();

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: {
        AGENT_OBSERVABILITY_ENABLED: "false",
        LANGFUSE_PUBLIC_KEY: "pk-lf-test",
        LANGFUSE_SECRET_KEY: "sk-lf-test",
      },
    });

    expect(cfg.observabilityEnabled).toBe(false);
    expect(cfg.observability?.publicKey).toBe("pk-lf-test");
    expect(cfg.observability?.secretKey).toBe("sk-lf-test");
  });
});

// ---------------------------------------------------------------------------
// Directory resolution
// ---------------------------------------------------------------------------
describe("directory resolution", () => {
  test("relative outputDirectory resolved against cwd", async () => {
    const { cwd, home } = await makeTmpDirs();

    await writeJson(path.join(cwd, ".agent", "config.json"), {
      outputDirectory: "my-output",
    });

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: {},
    });

    expect(cfg.outputDirectory).toBe(path.join(cwd, "my-output"));
  });

  test("absolute outputDirectory used as-is", async () => {
    const { cwd, home } = await makeTmpDirs();

    await writeJson(path.join(cwd, ".agent", "config.json"), {
      outputDirectory: "/absolute/output/path",
    });

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: {},
    });

    expect(cfg.outputDirectory).toBe("/absolute/output/path");
  });

  test("relative uploadsDirectory resolved against cwd", async () => {
    const { cwd, home } = await makeTmpDirs();

    await writeJson(path.join(cwd, ".agent", "config.json"), {
      uploadsDirectory: "my-uploads",
    });

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: {},
    });

    expect(cfg.uploadsDirectory).toBe(path.join(cwd, "my-uploads"));
  });

  test("absolute uploadsDirectory used as-is", async () => {
    const { cwd, home } = await makeTmpDirs();

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: { AGENT_UPLOADS_DIR: "/abs/uploads" },
    });

    expect(cfg.uploadsDirectory).toBe("/abs/uploads");
  });

  test("default outputDirectory is undefined when not configured", async () => {
    const { cwd, home } = await makeTmpDirs();

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: {},
    });

    expect(cfg.outputDirectory).toBeUndefined();
  });

  test("default uploadsDirectory is undefined when not configured", async () => {
    const { cwd, home } = await makeTmpDirs();

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: {},
    });

    expect(cfg.uploadsDirectory).toBeUndefined();
  });

  test("skillsDirs populated with 4 paths (project, global, user, built-in)", async () => {
    const { cwd, home } = await makeTmpDirs();

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: {},
    });

    expect(cfg.skillsDirs).toHaveLength(4);
    expect(cfg.skillsDirs[0]).toBe(path.join(cwd, ".agent", "skills"));
    expect(cfg.skillsDirs[1]).toBe(path.join(home, ".cowork", "skills"));
    expect(cfg.skillsDirs[2]).toBe(path.join(home, ".agent", "skills"));
    expect(cfg.skillsDirs[3]).toBe(path.join(repoRoot(), "skills"));
  });

  test("memoryDirs populated correctly", async () => {
    const { cwd, home } = await makeTmpDirs();

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: {},
    });

    expect(cfg.memoryDirs).toHaveLength(2);
    expect(cfg.memoryDirs[0]).toBe(path.join(cwd, ".agent", "memory"));
    expect(cfg.memoryDirs[1]).toBe(path.join(home, ".agent", "memory"));
  });

  test("configDirs populated correctly", async () => {
    const { cwd, home } = await makeTmpDirs();

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: {},
    });

    expect(cfg.configDirs).toHaveLength(3);
    expect(cfg.configDirs[0]).toBe(path.join(cwd, ".agent"));
    expect(cfg.configDirs[1]).toBe(path.join(home, ".agent"));
    expect(cfg.configDirs[2]).toBe(path.join(repoRoot(), "config"));
  });

  test("projectAgentDir and userAgentDir set correctly", async () => {
    const { cwd, home } = await makeTmpDirs();

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: {},
    });

    expect(cfg.projectAgentDir).toBe(path.join(cwd, ".agent"));
    expect(cfg.userAgentDir).toBe(path.join(home, ".agent"));
  });

  test("builtInDir and builtInConfigDir set correctly", async () => {
    const { cwd, home } = await makeTmpDirs();

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: {},
    });

    expect(cfg.builtInDir).toBe(repoRoot());
    expect(cfg.builtInConfigDir).toBe(path.join(repoRoot(), "config"));
  });
});

// ---------------------------------------------------------------------------
// getModel
// ---------------------------------------------------------------------------
describe("getModel", () => {
  test("returns google() model for google provider", async () => {
    const { cwd, home } = await makeTmpDirs();

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: { AGENT_PROVIDER: "google" },
    });

    const model = getModel(cfg);
    expect(model).toBeDefined();
  });

  test("returns openai() model for openai provider", async () => {
    const { cwd, home } = await makeTmpDirs();

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: { AGENT_PROVIDER: "openai" },
    });

    const model = getModel(cfg);
    expect(model).toBeDefined();
  });

  test("returns anthropic() model for anthropic provider", async () => {
    const { cwd, home } = await makeTmpDirs();

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: { AGENT_PROVIDER: "anthropic" },
    });

    const model = getModel(cfg);
    expect(model).toBeDefined();
  });

  test("custom model ID passed through overrides config model", async () => {
    const { cwd, home } = await makeTmpDirs();

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: { AGENT_PROVIDER: "google" },
    });

    const model = getModel(cfg, "gemini-custom-override");
    expect(model).toBeDefined();
  });

  test("uses config.model when no override ID provided", async () => {
    const { cwd, home } = await makeTmpDirs();

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: { AGENT_PROVIDER: "google", AGENT_MODEL: "gemini-specific" },
    });

    const model = getModel(cfg);
    expect(model).toBeDefined();
    expect(cfg.model).toBe("gemini-specific");
  });
});

// ---------------------------------------------------------------------------
// defaultModelForProvider
// ---------------------------------------------------------------------------
describe("defaultModelForProvider", () => {
  for (const providerName of Object.keys(PROVIDER_MODEL_CATALOG) as (keyof typeof PROVIDER_MODEL_CATALOG)[]) {
    test(`returns correct default for ${providerName}`, () => {
      expect(defaultModelForProvider(providerName)).toBe(PROVIDER_MODEL_CATALOG[providerName].defaultModel);
    });
  }
});

// ---------------------------------------------------------------------------
// Helper functions (tested indirectly through loadConfig behavior)
// ---------------------------------------------------------------------------
describe("deepMerge (tested indirectly through recognized fields)", () => {
  test("project config overrides user config for same field", async () => {
    const { cwd, home } = await makeTmpDirs();

    await writeJson(path.join(home, ".agent", "config.json"), {
      userName: "UserLevel",
      knowledgeCutoff: "2024",
    });

    await writeJson(path.join(cwd, ".agent", "config.json"), {
      userName: "ProjectLevel",
    });

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: {},
    });

    // Project overrides user for userName
    expect(cfg.userName).toBe("ProjectLevel");
    // User-level knowledgeCutoff preserved when not overridden
    expect(cfg.knowledgeCutoff).toBe("2024");
  });

  test("does not mutate original objects (verified by loading twice)", async () => {
    const { cwd, home } = await makeTmpDirs();

    await writeJson(path.join(home, ".agent", "config.json"), {
      userName: "Alice",
    });

    const cfg1 = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: {},
    });

    await writeJson(path.join(cwd, ".agent", "config.json"), {
      userName: "Bob",
    });

    const cfg2 = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: {},
    });

    expect(cfg1.userName).toBe("Alice");
    expect(cfg2.userName).toBe("Bob");
  });

  test("built-in defaults are used when no overrides exist", async () => {
    const { cwd, home } = await makeTmpDirs();

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: {},
    });

    // Provider should come from built-in defaults
    expect(cfg.provider).toBe("google");
    expect(cfg.model).toBeTruthy();
  });
});

describe("loadJsonSafe (tested indirectly)", () => {
  test("returns {} for missing files (config loads without error)", async () => {
    const { cwd, home } = await makeTmpDirs();

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: {},
    });

    expect(cfg).toBeDefined();
    expect(cfg.provider).toBe("google");
  });

  test("returns {} for invalid JSON (config loads without error)", async () => {
    const { cwd, home } = await makeTmpDirs();

    const configPath = path.join(cwd, ".agent", "config.json");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, "NOT VALID JSON {{{", "utf-8");

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: {},
    });

    expect(cfg).toBeDefined();
    expect(cfg.provider).toBe("google");
  });

  test("parses valid JSON correctly", async () => {
    const { cwd, home } = await makeTmpDirs();

    await writeJson(path.join(cwd, ".agent", "config.json"), {
      provider: "anthropic",
      model: "claude-valid",
    });

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: {},
    });

    expect(cfg.provider).toBe("anthropic");
    expect(cfg.model).toBe("claude-valid");
  });
});
