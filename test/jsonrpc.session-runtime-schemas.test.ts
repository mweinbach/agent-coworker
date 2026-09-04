import { describe, expect, test } from "bun:test";

import {
  sessionDefaultsApplyResultSchema,
  sessionStateReadResultSchema,
} from "../src/server/jsonrpc/schema.sessionRuntime";
import { jsonRpcControlRequestSchemas } from "../src/shared/jsonrpcControlSchemas";

const defaultsApply = jsonRpcControlRequestSchemas["cowork/session/defaults/apply"];
const stateRead = jsonRpcControlRequestSchemas["cowork/session/state/read"];
const defaultsApplyResult = sessionDefaultsApplyResultSchema;
const stateReadResult = sessionStateReadResultSchema;

function rejects(schema: { safeParse: (value: unknown) => { success: boolean } }, value: unknown) {
  expect(schema.safeParse(value).success).toBe(false);
}

describe("session runtime request schemas", () => {
  test("trims cwd, threadId, and model on defaults/apply", () => {
    expect(
      defaultsApply.parse({
        cwd: "  /workspace  ",
        threadId: "  thread-1  ",
        provider: "google",
        model: "  gemini-2.5-flash  ",
      }),
    ).toEqual({
      cwd: "/workspace",
      threadId: "thread-1",
      provider: "google",
      model: "gemini-2.5-flash",
    });
  });

  test("rejects unknown providers, blank ids, extras, and invalid config values", () => {
    rejects(defaultsApply, { provider: "chatgpt", model: "gpt-4o" });
    rejects(defaultsApply, { provider: "google" });
    rejects(defaultsApply, { model: "gemini-2.5-flash" });
    rejects(defaultsApply, { cwd: "   " });
    rejects(defaultsApply, { threadId: "" });
    rejects(defaultsApply, { extra: true });
    rejects(defaultsApply, {
      config: { childModelRoutingMode: "always-parent" },
    });
    rejects(defaultsApply, {
      config: { skillImprovementScope: "workspace" },
    });
    rejects(defaultsApply, {
      config: { toolOutputOverflowChars: 1.5 },
    });
  });

  test("rejects unknown or invalid nested provider options", () => {
    rejects(defaultsApply, {
      config: { providerOptions: { anthropic: { temperature: 0 } } },
    });
    rejects(defaultsApply, {
      config: { providerOptions: { openai: { reasoningEffort: "dynamic" } } },
    });
    rejects(defaultsApply, {
      config: { providerOptions: { openai: { reasoningEffort: "high", extra: true } } },
    });
    rejects(defaultsApply, {
      config: { providerOptions: { "codex-cli": { webSearchBackend: "bing" } } },
    });
    rejects(defaultsApply, {
      config: {
        providerOptions: { "codex-cli": { webSearch: { contextSize: "huge" } } },
      },
    });
    rejects(defaultsApply, {
      config: {
        providerOptions: { "codex-cli": { webSearch: { contextSize: "low", extra: true } } },
      },
    });
    rejects(defaultsApply, {
      config: {
        providerOptions: { google: { thinkingConfig: { thinkingLevel: "dynamic" } } },
      },
    });
    rejects(defaultsApply, {
      config: {
        providerOptions: { google: { thinkingConfig: { thinkingLevel: "low", extra: true } } },
      },
    });
    rejects(defaultsApply, {
      config: { providerOptions: { google: { responseMimeType: "   " } } },
    });
    rejects(defaultsApply, {
      config: { providerOptions: { lmstudio: { contextLength: 0 } } },
    });
    rejects(defaultsApply, {
      config: { providerOptions: { lmstudio: { contextLength: 1.5 } } },
    });
    rejects(defaultsApply, {
      config: { providerOptions: { lmstudio: { contextLength: -8 } } },
    });
  });

  test("accepts extra top-level config keys while keeping providerOptions strict", () => {
    expect(
      defaultsApply.parse({
        config: {
          backupsEnabled: true,
          experimentalFlag: true,
          providerOptions: { google: { nativeWebSearch: true } },
        },
      }),
    ).toMatchObject({
      config: {
        backupsEnabled: true,
        experimentalFlag: true,
        providerOptions: { google: { nativeWebSearch: true } },
      },
    });
  });

  test("state/read accepts empty objects or a cwd only", () => {
    expect(stateRead.parse({})).toEqual({});
    expect(stateRead.parse({ cwd: "  /workspace  " })).toEqual({ cwd: "/workspace" });
    rejects(stateRead, { threadId: "thread-1" });
    rejects(stateRead, { cwd: "   " });
  });
});

describe("session runtime result schemas", () => {
  test("defaults/apply requires a session_config event with a non-blank sessionId", () => {
    expect(
      defaultsApplyResult.parse({
        event: {
          type: "session_config",
          sessionId: "session-1",
          config: { yolo: false },
        },
      }).event.sessionId,
    ).toBe("session-1");
    rejects(defaultsApplyResult, {
      event: {
        type: "session_settings",
        sessionId: "session-1",
        enableMcp: true,
        enableMemory: true,
        memoryRequireApproval: false,
      },
    });
    rejects(defaultsApplyResult, {
      event: {
        type: "session_config",
        sessionId: "   ",
        config: {},
      },
    });
  });

  test("state/read requires at least one known event and rejects incomplete settings", () => {
    expect(
      stateReadResult.parse({
        events: [
          {
            type: "session_config",
            sessionId: "session-1",
            config: {},
          },
        ],
      }).events,
    ).toHaveLength(1);
    rejects(stateReadResult, { events: [] });
    rejects(stateReadResult, {
      events: [{ type: "session_info", sessionId: "session-1" }],
    });
    rejects(stateReadResult, {
      events: [
        {
          type: "session_settings",
          sessionId: "session-1",
          enableMcp: true,
          enableMemory: true,
        },
      ],
    });
  });
});
