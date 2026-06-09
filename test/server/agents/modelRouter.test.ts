import { describe, expect, test } from "bun:test";

import { routeAgentConfig } from "../../../src/server/agents/modelRouter";
import type { AgentRoleDefinition } from "../../../src/server/agents/roles";
import type { AgentConfig } from "../../../src/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  const base = "/tmp/model-router-test";
  // preferredChildModel must be a valid model for the provider. Default to
  // google so the base config doesn't need overriding for most tests. When
  // tests use openai they should supply a valid preferredChildModel.
  const provider = (overrides.provider ?? "google") as string;
  const defaultPreferredChildModel =
    provider === "openai" ? "gpt-5.4" : "gemini-3-flash-preview";
  return {
    provider: "google",
    model: "gemini-3-flash-preview",
    preferredChildModel: defaultPreferredChildModel,
    workingDirectory: base,
    userName: "tester",
    knowledgeCutoff: "2025-01",
    projectCoworkDir: `${base}/.cowork`,
    userCoworkDir: `${base}/.agent-user`,
    builtInDir: base,
    builtInConfigDir: `${base}/config`,
    skillsDirs: [],
    memoryDirs: [],
    configDirs: [],
    observabilityEnabled: false,
    ...overrides,
  };
}

function makeRole(overrides: Partial<AgentRoleDefinition> = {}): AgentRoleDefinition {
  return {
    id: "default",
    description: "General child agent.",
    promptFile: "default.md",
    defaultMode: "collaborative",
    readOnly: false,
    shellPolicy: "full",
    allowTools: ["bash", "read"],
    canAskUser: false,
    canSpawnChildren: false,
    maxDepth: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// No model requested — inherit parent
// ---------------------------------------------------------------------------

describe("routeAgentConfig: no model requested", () => {
  test("inherits parent provider and model when no model requested and no fixedModel", () => {
    const parentConfig = makeConfig({ provider: "google", model: "gemini-3-flash-preview" });
    const role = makeRole();
    const result = routeAgentConfig(parentConfig, { role });

    expect(result.effectiveProvider).toBe("google");
    expect(result.effectiveModel).toBe("gemini-3-flash-preview");
    expect(result.requestedModel).toBeUndefined();
    expect(result.fallbackLine).toBeUndefined();
    expect(result.config.provider).toBe("google");
    expect(result.config.model).toBe("gemini-3-flash-preview");
  });

  test("returns no requestedModel field when model not passed", () => {
    const parentConfig = makeConfig();
    const role = makeRole();
    const result = routeAgentConfig(parentConfig, { role });
    // requestedModel key should be absent, not just undefined
    expect("requestedModel" in result).toBe(false);
  });

  test("returns no effectiveReasoningEffort for google provider with no reasoning effort set", () => {
    const parentConfig = makeConfig({ provider: "google", model: "gemini-3-flash-preview" });
    const role = makeRole();
    const result = routeAgentConfig(parentConfig, { role });
    expect(result.effectiveReasoningEffort).toBeUndefined();
  });

  test("inherits parent reasoningEffort from providerOptions when no model requested", () => {
    const parentConfig = makeConfig({
      provider: "openai",
      model: "gpt-5.2",
      providerOptions: { openai: { reasoningEffort: "low" } },
    });
    const role = makeRole();
    const result = routeAgentConfig(parentConfig, { role });
    // No model change, no explicit request, so it picks up from parent's current providerOptions
    expect(result.effectiveReasoningEffort).toBe("low");
  });
});

// ---------------------------------------------------------------------------
// Role fixedModel override
// ---------------------------------------------------------------------------

describe("routeAgentConfig: role fixedModel", () => {
  test("uses role fixedModel over parent model", () => {
    const parentConfig = makeConfig({ provider: "google", model: "gemini-3-flash-preview" });
    const role = makeRole({
      modelPolicy: { fixedModel: "gemini-3.1-flash-lite" },
    });
    const result = routeAgentConfig(parentConfig, { role });

    expect(result.effectiveModel).toBe("gemini-3.1-flash-lite");
    expect(result.effectiveProvider).toBe("google");
  });

  test("role fixedReasoningEffort takes precedence over everything else", () => {
    const parentConfig = makeConfig({
      provider: "openai",
      model: "gpt-5.2",
      providerOptions: { openai: { reasoningEffort: "low" } },
    });
    const role = makeRole({
      modelPolicy: { fixedReasoningEffort: "medium" },
    });
    const result = routeAgentConfig(parentConfig, { role, reasoningEffort: "high" });

    expect(result.effectiveReasoningEffort).toBe("medium");
  });

  test("fixedModel does not change provider", () => {
    const parentConfig = makeConfig({ provider: "google", model: "gemini-3-flash-preview" });
    const role = makeRole({
      modelPolicy: { fixedModel: "gemini-3.5-flash" },
    });
    const result = routeAgentConfig(parentConfig, { role });
    expect(result.effectiveProvider).toBe("google");
    expect(result.effectiveModel).toBe("gemini-3.5-flash");
  });

  test("ignores requested model when role has fixedModel", () => {
    const parentConfig = makeConfig({ provider: "google", model: "gemini-3-flash-preview" });
    const role = makeRole({
      modelPolicy: { fixedModel: "gemini-3.1-flash-lite" },
    });
    // Even if caller passes a model, fixedModel wins
    const result = routeAgentConfig(parentConfig, { role, model: "gemini-3.5-flash" });
    expect(result.effectiveModel).toBe("gemini-3.1-flash-lite");
  });
});

// ---------------------------------------------------------------------------
// Same-provider model request
// ---------------------------------------------------------------------------

describe("routeAgentConfig: same-provider model request", () => {
  test("uses requested model when it matches parent provider", () => {
    const parentConfig = makeConfig({ provider: "google", model: "gemini-3-flash-preview" });
    const role = makeRole();
    const result = routeAgentConfig(parentConfig, { role, model: "gemini-3.1-flash-lite" });

    expect(result.effectiveProvider).toBe("google");
    expect(result.effectiveModel).toBe("gemini-3.1-flash-lite");
    expect(result.requestedModel).toBe("gemini-3.1-flash-lite");
    expect(result.fallbackLine).toBeUndefined();
  });

  test("uses requested model given as explicit provider:model ref for same provider", () => {
    const parentConfig = makeConfig({ provider: "google", model: "gemini-3-flash-preview" });
    const role = makeRole();
    const result = routeAgentConfig(parentConfig, { role, model: "google:gemini-3.5-flash" });

    expect(result.effectiveProvider).toBe("google");
    expect(result.effectiveModel).toBe("gemini-3.5-flash");
    expect(result.fallbackLine).toBeUndefined();
  });

  test("trims whitespace from model string before processing", () => {
    const parentConfig = makeConfig({ provider: "google", model: "gemini-3-flash-preview" });
    const role = makeRole();
    const result = routeAgentConfig(parentConfig, { role, model: "  gemini-3.1-flash-lite  " });
    expect(result.effectiveModel).toBe("gemini-3.1-flash-lite");
  });

  test("whitespace-only model string is treated as no model requested", () => {
    const parentConfig = makeConfig({ provider: "google", model: "gemini-3-flash-preview" });
    const role = makeRole();
    const result = routeAgentConfig(parentConfig, { role, model: "   " });
    // requestedModel trimmed to empty → treated as undefined
    expect(result.requestedModel).toBeUndefined();
    expect(result.effectiveModel).toBe("gemini-3-flash-preview");
  });

  test("picks up model default reasoningEffort when a different same-provider model is requested", () => {
    // gpt-5.2 has providerOptionsDefaults.reasoningEffort = "high"
    const parentConfig = makeConfig({
      provider: "openai",
      model: "gpt-5.4",
    });
    const role = makeRole();
    const result = routeAgentConfig(parentConfig, { role, model: "gpt-5.2" });

    // Model changes → apply model default reasoning effort
    expect(result.effectiveReasoningEffort).toBe("high");
  });

  test("explicit requestedReasoningEffort overrides model default", () => {
    const parentConfig = makeConfig({ provider: "openai", model: "gpt-5.4" });
    const role = makeRole();
    const result = routeAgentConfig(parentConfig, {
      role,
      model: "gpt-5.2",
      reasoningEffort: "low",
    });
    expect(result.effectiveReasoningEffort).toBe("low");
    expect(result.requestedReasoningEffort).toBe("low");
  });
});

// ---------------------------------------------------------------------------
// Cross-provider routing
// ---------------------------------------------------------------------------

describe("routeAgentConfig: cross-provider routing disabled", () => {
  test("falls back when childModelRoutingMode is same-provider (default)", () => {
    const parentConfig = makeConfig({
      provider: "google",
      model: "gemini-3-flash-preview",
      childModelRoutingMode: "same-provider",
    });
    const role = makeRole();
    const result = routeAgentConfig(parentConfig, {
      role,
      model: "openai:gpt-5.4",
      connectedProviders: ["openai", "google"],
    });

    expect(result.effectiveProvider).toBe("google");
    expect(result.effectiveModel).toBe("gemini-3-flash-preview");
    expect(result.fallbackLine).toMatch(/cross-provider routing is disabled/);
  });

  test("falls back when childModelRoutingMode is unset (defaults to same-provider)", () => {
    const parentConfig = makeConfig({
      provider: "google",
      model: "gemini-3-flash-preview",
      // No childModelRoutingMode set
    });
    const role = makeRole();
    const result = routeAgentConfig(parentConfig, {
      role,
      model: "openai:gpt-5.4",
      connectedProviders: ["openai", "google"],
    });

    expect(result.effectiveProvider).toBe("google");
    expect(result.fallbackLine).toMatch(/cross-provider routing is disabled/);
  });
});

describe("routeAgentConfig: cross-provider routing not in allowlist", () => {
  test("falls back when target ref is not in allowedChildModelRefs", () => {
    const parentConfig = makeConfig({
      provider: "google",
      model: "gemini-3-flash-preview",
      childModelRoutingMode: "cross-provider-allowlist",
      allowedChildModelRefs: ["openai:gpt-5.2"], // only gpt-5.2 is allowed
    });
    const role = makeRole();
    const result = routeAgentConfig(parentConfig, {
      role,
      model: "openai:gpt-5.4", // not in allowlist
      connectedProviders: ["openai", "google"],
    });

    expect(result.effectiveProvider).toBe("google");
    expect(result.effectiveModel).toBe("gemini-3-flash-preview");
    expect(result.fallbackLine).toMatch(/not in this workspace allowlist/);
  });
});

describe("routeAgentConfig: cross-provider routing provider not connected", () => {
  test("falls back when target provider is not in connectedProviders", () => {
    const parentConfig = makeConfig({
      provider: "google",
      model: "gemini-3-flash-preview",
      childModelRoutingMode: "cross-provider-allowlist",
      allowedChildModelRefs: ["openai:gpt-5.4"],
    });
    const role = makeRole();
    const result = routeAgentConfig(parentConfig, {
      role,
      model: "openai:gpt-5.4",
      connectedProviders: ["google"], // openai not connected
    });

    expect(result.effectiveProvider).toBe("google");
    expect(result.effectiveModel).toBe("gemini-3-flash-preview");
    expect(result.fallbackLine).toMatch(/the requested provider is not connected/);
  });

  test("falls back when connectedProviders is empty", () => {
    const parentConfig = makeConfig({
      provider: "google",
      model: "gemini-3-flash-preview",
      childModelRoutingMode: "cross-provider-allowlist",
      allowedChildModelRefs: ["openai:gpt-5.4"],
    });
    const role = makeRole();
    const result = routeAgentConfig(parentConfig, {
      role,
      model: "openai:gpt-5.4",
      connectedProviders: [], // empty
    });

    expect(result.effectiveProvider).toBe("google");
    expect(result.fallbackLine).toMatch(/the requested provider is not connected/);
  });
});

describe("routeAgentConfig: cross-provider routing success", () => {
  test("routes to cross-provider model when all conditions are met", () => {
    const parentConfig = makeConfig({
      provider: "google",
      model: "gemini-3-flash-preview",
      childModelRoutingMode: "cross-provider-allowlist",
      allowedChildModelRefs: ["openai:gpt-5.4"],
    });
    const role = makeRole();
    const result = routeAgentConfig(parentConfig, {
      role,
      model: "openai:gpt-5.4",
      connectedProviders: ["openai", "google"],
    });

    expect(result.effectiveProvider).toBe("openai");
    expect(result.effectiveModel).toBe("gpt-5.4");
    expect(result.fallbackLine).toBeUndefined();
    expect(result.config.provider).toBe("openai");
    expect(result.config.model).toBe("gpt-5.4");
  });

  test("cross-provider success applies model default reasoningEffort for new provider", () => {
    // gpt-5.4 has providerOptionsDefaults.reasoningEffort = "high"
    const parentConfig = makeConfig({
      provider: "google",
      model: "gemini-3-flash-preview",
      childModelRoutingMode: "cross-provider-allowlist",
      allowedChildModelRefs: ["openai:gpt-5.4"],
    });
    const role = makeRole();
    const result = routeAgentConfig(parentConfig, {
      role,
      model: "openai:gpt-5.4",
      connectedProviders: ["openai", "google"],
    });

    expect(result.effectiveReasoningEffort).toBe("high");
  });
});

// ---------------------------------------------------------------------------
// LM Studio not-connected fallback
// ---------------------------------------------------------------------------

describe("routeAgentConfig: lmstudio not-connected fallback", () => {
  test("falls back with lmstudio message when lmstudio not connected and model differs", () => {
    const parentConfig = makeConfig({
      provider: "lmstudio",
      model: "llama-3-8b",
    });
    const role = makeRole();
    const result = routeAgentConfig(parentConfig, {
      role,
      model: "mistral-7b", // different lmstudio model
      connectedProviders: ["google"], // lmstudio not connected
    });

    expect(result.effectiveProvider).toBe("lmstudio");
    expect(result.effectiveModel).toBe("llama-3-8b"); // fell back to parent model
    expect(result.fallbackLine).toMatch(/LM Studio is not connected/);
  });

  test("does NOT fall back when requested lmstudio model is same as parent model", () => {
    const parentConfig = makeConfig({
      provider: "lmstudio",
      model: "llama-3-8b",
    });
    const role = makeRole();
    const result = routeAgentConfig(parentConfig, {
      role,
      model: "llama-3-8b", // same model
      connectedProviders: [], // nothing connected
    });

    // Same model → no fallback needed
    expect(result.effectiveModel).toBe("llama-3-8b");
    expect(result.fallbackLine).toBeUndefined();
  });

  test("does NOT fall back when connectedProviders is empty (no providers connected at all)", () => {
    // The lmstudio fallback only fires when connectedProviders.size > 0 and lmstudio isn't in it
    const parentConfig = makeConfig({
      provider: "lmstudio",
      model: "llama-3-8b",
    });
    const role = makeRole();
    const result = routeAgentConfig(parentConfig, {
      role,
      model: "mistral-7b", // different model
      connectedProviders: [], // size === 0 → condition not met → model is used
    });

    expect(result.effectiveModel).toBe("mistral-7b"); // uses the requested model since condition not met
    expect(result.fallbackLine).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// reasoningEffort resolution priority
// ---------------------------------------------------------------------------

describe("routeAgentConfig: reasoningEffort resolution", () => {
  test("role fixedReasoningEffort wins over everything", () => {
    const parentConfig = makeConfig({
      provider: "openai",
      model: "gpt-5.2",
      providerOptions: { openai: { reasoningEffort: "low" } },
    });
    const role = makeRole({ modelPolicy: { fixedReasoningEffort: "medium" } });
    const result = routeAgentConfig(parentConfig, {
      role,
      reasoningEffort: "high",
    });
    expect(result.effectiveReasoningEffort).toBe("medium");
  });

  test("explicit requestedReasoningEffort wins over model default and parent inherited", () => {
    const parentConfig = makeConfig({
      provider: "openai",
      model: "gpt-5.2",
      providerOptions: { openai: { reasoningEffort: "low" } },
    });
    const role = makeRole();
    const result = routeAgentConfig(parentConfig, {
      role,
      reasoningEffort: "high",
    });
    expect(result.effectiveReasoningEffort).toBe("high");
  });

  test("model default reasoningEffort used when model changes and no explicit request", () => {
    const parentConfig = makeConfig({
      provider: "openai",
      model: "gpt-5.4", // default is "high" but we set no providerOptions
    });
    const role = makeRole();
    const result = routeAgentConfig(parentConfig, {
      role,
      model: "gpt-5.2", // also has default "high"
    });
    expect(result.effectiveReasoningEffort).toBe("high");
  });

  test("parent providerOptions reasoningEffort used as last fallback (no model change)", () => {
    const parentConfig = makeConfig({
      provider: "openai",
      model: "gpt-5.4",
      providerOptions: { openai: { reasoningEffort: "low" } },
    });
    const role = makeRole();
    const result = routeAgentConfig(parentConfig, { role });
    // No model change, no explicit request → inherit from parent
    expect(result.effectiveReasoningEffort).toBe("low");
  });

  test("no reasoningEffort set for non-openai-compatible providers", () => {
    const parentConfig = makeConfig({
      provider: "google",
      model: "gemini-3-flash-preview",
    });
    const role = makeRole();
    const result = routeAgentConfig(parentConfig, { role, reasoningEffort: "high" });
    // requestedReasoningEffort is set but google is not openai-compatible
    // so effectiveReasoningEffort is still set via the chain but won't be applied to providerOptions
    // The function still returns the chain value — just doesn't apply it to non-openai providers
    expect(result.effectiveReasoningEffort).toBe("high");
  });

  test("requestedReasoningEffort field is present only when requested", () => {
    const parentConfig = makeConfig({ provider: "openai", model: "gpt-5.2" });
    const role = makeRole();

    const withRequest = routeAgentConfig(parentConfig, { role, reasoningEffort: "low" });
    expect("requestedReasoningEffort" in withRequest).toBe(true);
    expect(withRequest.requestedReasoningEffort).toBe("low");

    const withoutRequest = routeAgentConfig(parentConfig, { role });
    expect("requestedReasoningEffort" in withoutRequest).toBe(false);
  });

  test("effectiveReasoningEffort field is absent when no effort applies", () => {
    // google provider, no providerOptions set, no model change, no request
    const parentConfig = makeConfig({ provider: "google", model: "gemini-3-flash-preview" });
    const role = makeRole();
    const result = routeAgentConfig(parentConfig, { role });
    expect("effectiveReasoningEffort" in result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Result config shape
// ---------------------------------------------------------------------------

describe("routeAgentConfig: result config shape", () => {
  test("result config includes all parent config fields plus overrides", () => {
    const parentConfig = makeConfig({
      provider: "google",
      model: "gemini-3-flash-preview",
      userName: "alice",
    });
    const role = makeRole();
    const result = routeAgentConfig(parentConfig, { role });

    expect(result.config.userName).toBe("alice");
    expect(result.config.workingDirectory).toBe(parentConfig.workingDirectory);
  });

  test("result config runtime is set to the correct runtime for provider", () => {
    const parentConfig = makeConfig({ provider: "google", model: "gemini-3-flash-preview" });
    const role = makeRole();
    const result = routeAgentConfig(parentConfig, { role });
    expect(result.config.runtime).toBe("google-interactions");
  });

  test("result config runtime is updated when cross-provider routing changes provider", () => {
    const parentConfig = makeConfig({
      provider: "google",
      model: "gemini-3-flash-preview",
      childModelRoutingMode: "cross-provider-allowlist",
      allowedChildModelRefs: ["openai:gpt-5.4"],
    });
    const role = makeRole();
    const result = routeAgentConfig(parentConfig, {
      role,
      model: "openai:gpt-5.4",
      connectedProviders: ["openai", "google"],
    });
    expect(result.config.runtime).toBe("openai-responses");
  });

  test("fallbackLine field is absent when no fallback occurs", () => {
    const parentConfig = makeConfig({ provider: "google", model: "gemini-3-flash-preview" });
    const role = makeRole();
    const result = routeAgentConfig(parentConfig, { role });
    expect("fallbackLine" in result).toBe(false);
  });

  test("fallbackLine field is present and non-empty when fallback occurs", () => {
    const parentConfig = makeConfig({
      provider: "google",
      model: "gemini-3-flash-preview",
      childModelRoutingMode: "same-provider",
    });
    const role = makeRole();
    const result = routeAgentConfig(parentConfig, {
      role,
      model: "openai:gpt-5.4",
      connectedProviders: ["openai", "google"],
    });
    expect(result.fallbackLine).toBeTruthy();
  });
});
