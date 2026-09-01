import { describe, expect, test } from "bun:test";

import {
  jsonRpcSessionRequestSchemas,
  jsonRpcSessionResultSchemas,
} from "../src/server/jsonrpc/schema.session";

const defaultsApply = jsonRpcSessionRequestSchemas["cowork/session/defaults/apply"];
const defaultsApplyResult = jsonRpcSessionResultSchemas["cowork/session/defaults/apply"];
const stateRead = jsonRpcSessionRequestSchemas["cowork/session/state/read"];
const stateReadResult = jsonRpcSessionResultSchemas["cowork/session/state/read"];

function expectReject(
  schema: { safeParse: (value: unknown) => { success: boolean } },
  value: unknown,
) {
  expect(schema.safeParse(value).success).toBe(false);
}

describe("session runtime request schemas", () => {
  test("accepts a minimal defaults apply payload and trims identifiers", () => {
    expect(defaultsApply.parse({})).toEqual({});
    expect(
      defaultsApply.parse({
        cwd: " /workspace/project ",
        threadId: " thread-1 ",
        provider: "google",
        model: " gemini-2.5-flash ",
        enableMcp: false,
        config: {
          childModelRoutingMode: "same-provider",
          skillImprovementScope: "user",
          toolOutputOverflowChars: 8_000,
          providerOptions: {
            openai: { reasoningEffort: "high", reasoningSummary: "auto", textVerbosity: "low" },
            "codex-cli": {
              reasoningEffort: "medium",
              webSearchBackend: "exa",
              webSearchFallbackBackend: "parallel",
              webSearchMode: "cached",
              webSearch: {
                contextSize: "low",
                allowedDomains: ["example.com"],
                location: { country: "US" },
              },
            },
            google: {
              nativeWebSearch: true,
              thinkingConfig: { thinkingLevel: "high" },
              responseMimeType: "text/plain",
            },
            lmstudio: { contextLength: 4096, autoLoad: true },
          },
        },
      }),
    ).toMatchObject({
      cwd: "/workspace/project",
      threadId: "thread-1",
      model: "gemini-2.5-flash",
    });
  });

  test("rejects unknown providers, blank identifiers, extras, and invalid routing", () => {
    expectReject(defaultsApply, { provider: "chatgpt" });
    expectReject(defaultsApply, { cwd: "   " });
    expectReject(defaultsApply, { threadId: "" });
    expectReject(defaultsApply, { model: "\n" });
    expectReject(defaultsApply, { extra: true });
    expectReject(defaultsApply, { config: { childModelRoutingMode: "any-provider" } });
    expectReject(defaultsApply, { config: { skillImprovementScope: "workspace" } });
    expectReject(defaultsApply, { config: { toolOutputOverflowChars: 12.5 } });
  });

  test("rejects unknown or invalid editable provider options fail-closed", () => {
    expectReject(defaultsApply, {
      config: { providerOptions: { anthropic: { reasoningEffort: "high" } } },
    });
    expectReject(defaultsApply, {
      config: { providerOptions: { openai: { reasoningEffort: "dynamic" } } },
    });
    expectReject(defaultsApply, {
      config: { providerOptions: { openai: { textVerbosity: "verbose" } } },
    });
    expectReject(defaultsApply, {
      config: { providerOptions: { openai: { temperature: 0.2 } } },
    });
    expectReject(defaultsApply, {
      config: { providerOptions: { "codex-cli": { webSearchBackend: "bing" } } },
    });
    expectReject(defaultsApply, {
      config: {
        providerOptions: { "codex-cli": { webSearch: { contextSize: "unlimited" } } },
      },
    });
    expectReject(defaultsApply, {
      config: { providerOptions: { "codex-cli": { webSearch: { extra: true } } } },
    });
    expectReject(defaultsApply, {
      config: { providerOptions: { google: { thinkingConfig: { thinkingLevel: "dynamic" } } } },
    });
    expectReject(defaultsApply, {
      config: { providerOptions: { google: { thinkingConfig: { extra: true } } } },
    });
    expectReject(defaultsApply, {
      config: { providerOptions: { google: { responseMimeType: "  " } } },
    });
    expectReject(defaultsApply, {
      config: { providerOptions: { lmstudio: { contextLength: 0 } } },
    });
    expectReject(defaultsApply, {
      config: { providerOptions: { lmstudio: { contextLength: 1.5 } } },
    });
    expectReject(defaultsApply, {
      config: { providerOptions: { lmstudio: { contextLength: -8 } } },
    });
  });

  test("state/read is an empty-or-cwd object only", () => {
    expect(stateRead.parse({})).toEqual({});
    expect(stateRead.parse({ cwd: " /tmp " })).toEqual({ cwd: "/tmp" });
    expectReject(stateRead, { cwd: "" });
    expectReject(stateRead, { threadId: "t1" });
  });
});

describe("session runtime result schemas", () => {
  test("defaults apply requires a session_config event", () => {
    expect(
      defaultsApplyResult.parse({
        event: {
          type: "session_config",
          sessionId: " session-1 ",
          config: {
            childModelRoutingMode: "cross-provider-allowlist",
            providerOptions: { google: { nativeWebSearch: false } },
          },
        },
      }).event.sessionId,
    ).toBe("session-1");

    expectReject(defaultsApplyResult, {
      event: {
        type: "session_settings",
        sessionId: "s1",
        enableMcp: true,
        enableMemory: true,
        memoryRequireApproval: false,
      },
    });
    expectReject(defaultsApplyResult, {
      event: { type: "session_config", sessionId: "  ", config: {} },
    });
    expectReject(defaultsApplyResult, { events: [] });
    expectReject(defaultsApplyResult, {
      event: { type: "session_config", sessionId: "s1", config: {} },
      extra: true,
    });
  });

  test("state/read requires at least one known session event", () => {
    expect(
      stateReadResult.parse({
        events: [
          {
            type: "config_updated",
            sessionId: "s1",
            config: { provider: "google", model: "gemini-2.5-flash", workingDirectory: "/tmp" },
          },
        ],
      }).events,
    ).toHaveLength(1);

    expectReject(stateReadResult, { events: [] });
    expectReject(stateReadResult, {
      event: { type: "session_config", sessionId: "s1", config: {} },
    });
    expectReject(stateReadResult, {
      events: [{ type: "session_info", title: "Chat" }],
    });
    expectReject(stateReadResult, {
      events: [
        {
          type: "session_settings",
          sessionId: "s1",
          enableMcp: true,
          enableMemory: false,
        },
      ],
    });
  });
});
