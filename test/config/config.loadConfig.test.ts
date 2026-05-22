import { describe, expect, mock, test } from "bun:test";
import { defaultModelForProvider, getModel } from "../../src/config";
import { PROVIDER_MODEL_CATALOG } from "../../src/providers";
import {
  fs,
  loadConfig,
  makeTmpDirs,
  os,
  path,
  repoRoot,
  withEnv,
  withMockedFetch,
  writeJson,
} from "./config.harness";

describe("loadConfig", () => {
  // ---- The two original tests ----

  test("defaults < user < project < env", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-coworker-"));
    const cwd = path.join(tmp, "project");
    const home = path.join(tmp, "home");

    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(home, { recursive: true });

    await writeJson(path.join(home, ".cowork", "config", "config.json"), {
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      outputDirectory: "user-output",
    });

    await writeJson(path.join(cwd, ".cowork", "config.json"), {
      provider: "openai",
      model: "gpt-5.2",
      outputDirectory: "project-output",
    });

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: {},
    });

    expect(cfg.provider).toBe("openai");
    expect(cfg.model).toBe("gpt-5.2");
    expect(cfg.outputDirectory).toBe(path.join(cwd, "project-output"));

    const cfgFallback = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: { AGENT_PROVIDER: "google", AGENT_MODEL: "gemini-test" },
    });
    expect(cfgFallback.provider).toBe("google");
    expect(cfgFallback.model).toBe(defaultModelForProvider("google"));
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
    expect(cfg.model).toBe("gpt-5.4");
  });

  test("keeps A2UI absent by default outside the experiment", async () => {
    const { cwd, home } = await makeTmpDirs();

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: { AGENT_PROVIDER: "openai" },
    });

    expect(cfg.enableA2ui).toBeUndefined();
    expect(cfg.featureFlags?.workspace?.a2ui).toBeUndefined();
  });

  test("built-in skills stay enabled by default and only disable on explicit opt-out", async () => {
    const { cwd, home } = await makeTmpDirs();

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: {},
    });
    expect(cfg.skillsDirs).toContain(path.join(repoRoot(), "skills"));

    const disabled = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: { COWORK_DISABLE_BUILTIN_SKILLS: "1" },
    });
    expect(disabled.skillsDirs).not.toContain(path.join(repoRoot(), "skills"));
  });

  test("accepts arbitrary LM Studio model ids discovered at runtime", async () => {
    const { cwd, home } = await makeTmpDirs();

    await withMockedFetch(
      (async () =>
        new Response(
          JSON.stringify({
            models: [
              {
                type: "llm",
                publisher: "local",
                key: "local/qwen-2.5",
                display_name: "Qwen 2.5 Local",
                loaded_instances: [],
                max_context_length: 32768,
                capabilities: { vision: false, trained_for_tool_use: false },
                size_bytes: 1,
              },
            ],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        )) as typeof fetch,
      async () => {
        const cfg = await loadConfig({
          cwd,
          homedir: home,
          builtInDir: repoRoot(),
          env: {
            AGENT_PROVIDER: "lmstudio",
            AGENT_MODEL: "local/qwen-2.5",
          },
        });

        expect(cfg.provider).toBe("lmstudio");
        expect(cfg.model).toBe("local/qwen-2.5");
        expect(cfg.preferredChildModel).toBe("local/qwen-2.5");
        expect(cfg.knowledgeCutoff).toBe("Unknown");
      },
    );
  });

  test("uses the live LM Studio default selection policy when no model is configured", async () => {
    const { cwd, home } = await makeTmpDirs();

    await withMockedFetch(
      (async () =>
        new Response(
          JSON.stringify({
            models: [
              {
                type: "llm",
                publisher: "local",
                key: "local/beta",
                display_name: "Beta",
                loaded_instances: [],
                max_context_length: 32768,
                capabilities: { vision: false, trained_for_tool_use: false },
                size_bytes: 1,
              },
              {
                type: "llm",
                publisher: "local",
                key: "local/alpha",
                display_name: "Alpha",
                loaded_instances: [{ id: "inst-1", config: { context_length: 8192 } }],
                max_context_length: 32768,
                capabilities: { vision: false, trained_for_tool_use: false },
                size_bytes: 1,
              },
            ],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        )) as typeof fetch,
      async () => {
        const cfg = await loadConfig({
          cwd,
          homedir: home,
          builtInDir: repoRoot(),
          env: {
            AGENT_PROVIDER: "lmstudio",
          },
        });

        expect(cfg.provider).toBe("lmstudio");
        expect(cfg.model).toBe("local/alpha");
        expect(cfg.preferredChildModel).toBe("local/alpha");
      },
    );
  });

  test("runtime defaults follow the resolved provider and ignore unsupported AGENT_RUNTIME values", async () => {
    const { cwd, home } = await makeTmpDirs();

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: {},
    });
    expect(cfg.runtime).toBe("google-interactions");

    await writeJson(path.join(cwd, ".cowork", "config.json"), {
      provider: "openai",
      model: "gpt-5.4",
    });
    const openAiCfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: {},
    });
    expect(openAiCfg.runtime).toBe("openai-responses");

    const cfg2 = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: { AGENT_RUNTIME: "legacy-runtime" },
    });
    expect(cfg2.runtime).toBe("openai-responses");
  });

  test("legacy pi runtime config is normalized away for openai providers", async () => {
    const { cwd, home } = await makeTmpDirs();

    await writeJson(path.join(cwd, ".cowork", "config.json"), {
      provider: "openai",
      model: "gpt-5.4",
      runtime: "pi",
    });

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: {},
    });

    expect(cfg.provider).toBe("openai");
    expect(cfg.runtime).toBe("openai-responses");
  });

  test("legacy pi runtime config is normalized away for codex-cli providers", async () => {
    const { cwd, home } = await makeTmpDirs();

    await writeJson(path.join(cwd, ".cowork", "config.json"), {
      provider: "codex-cli",
      model: "gpt-5.4",
      runtime: "pi",
    });

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: {},
    });

    expect(cfg.provider).toBe("codex-cli");
    expect(cfg.runtime).toBe("codex-app-server");
  });

  test("stale OpenAI Responses runtime config is normalized away for non-OpenAI providers", async () => {
    const { cwd, home } = await makeTmpDirs();

    await writeJson(path.join(cwd, ".cowork", "config.json"), {
      provider: "google",
      model: "gemini-3-flash-preview",
      runtime: "openai-responses",
    });

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: {},
    });

    expect(cfg.provider).toBe("google");
    expect(cfg.runtime).toBe("google-interactions");
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
    expect(cfg.preferredChildModel).toBe(defaultModelForProvider("google"));
    expect(cfg.knowledgeCutoff).toBe("January 2025");
    expect(cfg.userName).toBe("");
    expect(cfg.observabilityEnabled).toBe(true);
    expect(cfg.toolOutputOverflowChars).toBe(25000);
  });

  test("project config can override toolOutputOverflowChars", async () => {
    const { cwd, home } = await makeTmpDirs();

    await writeJson(path.join(cwd, ".cowork", "config.json"), {
      toolOutputOverflowChars: 4096,
    });

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: {},
    });

    expect(cfg.toolOutputOverflowChars).toBe(4096);
  });

  test("project config can disable toolOutputOverflowChars with null", async () => {
    const { cwd, home } = await makeTmpDirs();

    await writeJson(path.join(cwd, ".cowork", "config.json"), {
      toolOutputOverflowChars: null,
    });

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: {},
    });

    expect(cfg.toolOutputOverflowChars).toBeNull();
  });

  test("user config from homedir/.cowork/config/config.json overrides defaults", async () => {
    const { cwd, home } = await makeTmpDirs();

    await writeJson(path.join(home, ".cowork", "config", "config.json"), {
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      userName: "Alice",
    });

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: {},
    });

    expect(cfg.provider).toBe("anthropic");
    expect(cfg.model).toBe("claude-sonnet-4-5");
    expect(cfg.userName).toBe("Alice");
  });

  test("project config from cwd/.cowork/config.json overrides user config", async () => {
    const { cwd, home } = await makeTmpDirs();

    await writeJson(path.join(home, ".cowork", "config", "config.json"), {
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      userName: "Alice",
    });

    await writeJson(path.join(cwd, ".cowork", "config.json"), {
      provider: "openai",
      model: "gpt-5.2",
    });

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: {},
    });

    expect(cfg.provider).toBe("openai");
    expect(cfg.model).toBe("gpt-5.2");
    expect(cfg.userName).toBe("Alice");
  });

  test("AGENT_PROVIDER env var overrides all config files", async () => {
    const { cwd, home } = await makeTmpDirs();

    await writeJson(path.join(cwd, ".cowork", "config.json"), {
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

    await writeJson(path.join(cwd, ".cowork", "config.json"), {
      provider: "openai",
      model: "gpt-5.4",
    });

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: { AGENT_MODEL: "gpt-5.2" },
    });
    expect(cfg.provider).toBe("openai");
    expect(cfg.model).toBe("gpt-5.2");
  });

  test("invalid configured model IDs fall back to provider defaults during startup", async () => {
    const { cwd, home } = await makeTmpDirs();

    await writeJson(path.join(cwd, ".cowork", "config.json"), {
      provider: "google",
      model: "gemini-legacy-preview",
      preferredChildModel: "gemini-legacy-research",
    });

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: {},
    });

    expect(cfg.provider).toBe("google");
    expect(cfg.model).toBe(defaultModelForProvider("google"));
    expect(cfg.preferredChildModel).toBe(cfg.model);
  });

  test("removed OpenAI model IDs load through legacy aliases", async () => {
    const { cwd, home } = await makeTmpDirs();

    await writeJson(path.join(cwd, ".cowork", "config.json"), {
      provider: "openai",
      model: "gpt-5.1",
      preferredChildModel: "gpt-5.2-codex",
    });

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: {},
    });

    expect(cfg.provider).toBe("openai");
    expect(cfg.model).toBe("gpt-5.4");
    expect(cfg.preferredChildModel).toBe("gpt-5.4");
    expect(cfg.preferredChildModelRef).toBe("openai:gpt-5.4");
  });

  test("removed Codex CLI model IDs load through legacy aliases", async () => {
    const { cwd, home } = await makeTmpDirs();

    await writeJson(path.join(cwd, ".cowork", "config.json"), {
      provider: "codex-cli",
      model: "gpt-5.1-codex-mini",
      preferredChildModel: "gpt-5.2-codex",
    });

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: {},
    });

    expect(cfg.provider).toBe("codex-cli");
    expect(cfg.model).toBe("gpt-5.4");
    expect(cfg.preferredChildModel).toBe("gpt-5.4");
    expect(cfg.preferredChildModelRef).toBe("codex-cli:gpt-5.4");
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

    await writeJson(path.join(cwd, ".cowork", "config.json"), {
      outputDirectory: "project-out",
    });

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: { AGENT_OUTPUT_DIR: path.join(cwd, "env-output") },
    });

    expect(cfg.outputDirectory).toBe(path.join(cwd, "env-output"));
  });

  test("AGENT_OUTPUT_DIR env var outside workspace falls back to cwd", async () => {
    const { cwd, home } = await makeTmpDirs();

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: { AGENT_OUTPUT_DIR: "/absolute/env-output" },
    });

    expect(cfg.outputDirectory).toBe(cwd);
  });

  test("AGENT_UPLOADS_DIR env var overrides all uploads directory config", async () => {
    const { cwd, home } = await makeTmpDirs();

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: { AGENT_UPLOADS_DIR: path.join(cwd, "env-uploads") },
    });

    expect(cfg.uploadsDirectory).toBe(path.join(cwd, "env-uploads"));
  });

  test("AGENT_UPLOADS_DIR env var outside workspace falls back to cwd", async () => {
    const { cwd, home } = await makeTmpDirs();

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: { AGENT_UPLOADS_DIR: "/tmp/env-uploads" },
    });

    expect(cfg.uploadsDirectory).toBe(cwd);
  });

  test("AGENT_USER_NAME env var overrides all userName config", async () => {
    const { cwd, home } = await makeTmpDirs();

    await writeJson(path.join(home, ".cowork", "config", "config.json"), {
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
    await writeJson(path.join(home, ".cowork", "config", "config.json"), {
      knowledgeCutoff: "user-level-cutoff",
      userName: "UserName",
    });

    // Project only sets userName (should override user)
    await writeJson(path.join(cwd, ".cowork", "config.json"), {
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
    // Registry knowledgeCutoff remains authoritative.
    expect(cfg.knowledgeCutoff).toBe("January 2025");
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

  test("preferredChildModel falls back to main model when not configured", async () => {
    const { cwd, home } = await makeTmpDirs();

    const customBuiltIn = path.join(os.tmpdir(), "builtin-nosub-" + Date.now());
    await writeJson(path.join(customBuiltIn, "config", "defaults.json"), {
      provider: "openai",
      model: "gpt-5.2",
    });

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: customBuiltIn,
      env: {},
    });

    expect(cfg.preferredChildModel).toBe("gpt-5.2");
  });

  test("preferredChildModel from project config overrides user config", async () => {
    const { cwd, home } = await makeTmpDirs();

    await writeJson(path.join(home, ".cowork", "config", "config.json"), {
      preferredChildModel: "gemini-3-flash-preview",
    });

    await writeJson(path.join(cwd, ".cowork", "config.json"), {
      preferredChildModel: "gemini-3.1-pro-preview",
    });

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: {},
    });

    expect(cfg.preferredChildModel).toBe("gemini-3.1-pro-preview");
  });

  test("legacy subAgentModel config still seeds the preferred child model", async () => {
    const { cwd, home } = await makeTmpDirs();

    await writeJson(path.join(cwd, ".cowork", "config.json"), {
      provider: "openai",
      model: "gpt-5.4",
      subAgentModel: "gpt-5-mini",
    });

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: {},
    });

    expect(cfg.preferredChildModel).toBe("gpt-5-mini");
    expect(cfg.preferredChildModelRef).toBe("openai:gpt-5-mini");
  });

  test("preferredChildModelRef and allowlist normalize cross-provider child routing config", async () => {
    const { cwd, home } = await makeTmpDirs();

    await writeJson(path.join(cwd, ".cowork", "config.json"), {
      provider: "codex-cli",
      model: "gpt-5.4",
      childModelRoutingMode: "cross-provider-allowlist",
      preferredChildModelRef: "opencode-zen:glm-5",
      allowedChildModelRefs: ["opencode-zen:glm-5", "opencode-go:glm-5"],
    });

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: {},
    });

    expect(cfg.childModelRoutingMode).toBe("cross-provider-allowlist");
    expect(cfg.preferredChildModelRef).toBe("opencode-zen:glm-5");
    expect(cfg.allowedChildModelRefs).toEqual(["opencode-zen:glm-5", "opencode-go:glm-5"]);
    expect(cfg.preferredChildModel).toBe("gpt-5.4");
  });

  test("knowledgeCutoff config values are ignored in favor of the selected model registry entry", async () => {
    const { cwd, home } = await makeTmpDirs();

    await writeJson(path.join(home, ".cowork", "config", "config.json"), {
      knowledgeCutoff: "User cutoff 2024",
    });

    await writeJson(path.join(cwd, ".cowork", "config.json"), {
      knowledgeCutoff: "Project cutoff 2025",
    });

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: {},
    });

    expect(cfg.knowledgeCutoff).toBe("January 2025");
  });

  test("invalid provider in config falls back to default", async () => {
    const { cwd, home } = await makeTmpDirs();

    await writeJson(path.join(cwd, ".cowork", "config.json"), {
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

    await writeJson(path.join(cwd, ".cowork", "config.json"), {
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

  test("reads saved API key only from canonical cowork connections file", async () => {
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
    await writeJson(path.join(home, ".cowork", "auth", "connections.json"), {
      version: 1,
      updatedAt: new Date().toISOString(),
      services: {
        openai: {
          service: "openai",
          mode: "api_key",
          apiKey: "canonical-service-key",
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

    await withEnv("HOME", home, async () => {
      const model = getModel(cfg) as any;
      const headers = await model.config.headers();
      expect(headers.authorization).toBe("Bearer canonical-service-key");
    });
  });

  test("throws when canonical connection store uses legacy apiKeys shape", async () => {
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

    await writeJson(path.join(home, ".cowork", "auth", "connections.json"), {
      apiKeys: {
        openai: "legacy-shape-key",
      },
    });

    await withEnv("HOME", home, async () => {
      expect(() => getModel(cfg)).toThrow("Invalid connection store schema");
    });
  });

  test("loads command template config from merged config", async () => {
    const { cwd, home } = await makeTmpDirs();

    await writeJson(path.join(cwd, ".cowork", "config.json"), {
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

  test("throws on invalid command template entries", async () => {
    const { cwd, home } = await makeTmpDirs();

    await writeJson(path.join(cwd, ".cowork", "config.json"), {
      command: {
        bad1: { template: "" },
        bad2: { description: "missing template" },
      },
    });

    await expect(
      loadConfig({
        cwd,
        homedir: home,
        builtInDir: repoRoot(),
        env: {},
      }),
    ).rejects.toThrow("Invalid command config");
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

    await writeJson(path.join(home, ".cowork", "config", "config.json"), {
      providerOptions: {
        openai: {
          reasoningSummary: "detailed",
        },
      },
    });

    await writeJson(path.join(cwd, ".cowork", "config.json"), {
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

  test("omits providerOptions when the active provider model has no defaults and config contributes none", async () => {
    const { cwd, home } = await makeTmpDirs();

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: {
        AGENT_PROVIDER: "opencode-go",
      },
    });

    expect(cfg.providerOptions).toBeUndefined();
  });

  test("preserves other providerOptions without synthesizing an empty active-provider section", async () => {
    const { cwd, home } = await makeTmpDirs();

    await writeJson(path.join(cwd, ".cowork", "config.json"), {
      providerOptions: {
        openai: {
          reasoningEffort: "high",
        },
      },
    });

    const cfg = await loadConfig({
      cwd,
      homedir: home,
      builtInDir: repoRoot(),
      env: {
        AGENT_PROVIDER: "opencode-go",
      },
    });

    expect(cfg.providerOptions).toEqual({
      openai: {
        reasoningEffort: "high",
      },
    });
    expect(cfg.providerOptions).not.toHaveProperty("opencode-go");
  });

  test("loads modelSettings maxRetries from config and allows env overrides", async () => {
    const { cwd, home } = await makeTmpDirs();

    await writeJson(path.join(cwd, ".cowork", "config.json"), {
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
    expect(cfg.observability?.otelEndpoint).toBe(
      "https://self-hosted.langfuse.example/api/public/otel/v1/traces",
    );
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
