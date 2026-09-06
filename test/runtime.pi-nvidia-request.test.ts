import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import type { ProviderStreamOptions } from "@earendil-works/pi-ai";
import { scratchRoots } from "../src/platform/sandbox";
import { createPiRuntime } from "../src/runtime/pi/runTurn";
import type { RuntimeRunTurnParams } from "../src/runtime/types";
import type { AgentConfig } from "../src/types";

let homeDir: string;

beforeEach(async () => {
  const [tempRoot] = scratchRoots();
  if (!tempRoot) throw new Error("No platform scratch root is available");
  homeDir = await fs.mkdtemp(path.join(tempRoot, "pi-nvidia-request-"));
});

afterEach(async () => {
  await fs.rm(homeDir, { recursive: true, force: true });
});

function makeParams(
  provider: "nvidia" | "opencode-go",
  streamOptions: ProviderStreamOptions,
  overrides: Partial<RuntimeRunTurnParams> = {},
): RuntimeRunTurnParams {
  const model = provider === "nvidia" ? "nvidia/nemotron-3-super-120b-a12b" : "glm-5";
  const config: AgentConfig = {
    provider,
    model,
    preferredChildModel: model,
    workingDirectory: homeDir,
    outputDirectory: path.join(homeDir, "output"),
    uploadsDirectory: path.join(homeDir, "uploads"),
    userName: "",
    knowledgeCutoff: "unknown",
    projectCoworkDir: path.join(homeDir, ".cowork"),
    userCoworkDir: path.join(homeDir, ".cowork"),
    builtInDir: homeDir,
    builtInConfigDir: path.join(homeDir, "config"),
    skillsDirs: [],
    memoryDirs: [],
    configDirs: [],
    modelSettings: { maxRetries: 0 },
  };
  return {
    config,
    system: "You are helpful.",
    messages: [{ role: "user", content: "hello" }],
    tools: {},
    maxSteps: 1,
    prepareStep: async () => ({
      streamOptions: { apiKey: "test-request-local-key", maxRetries: 0, ...streamOptions },
    }),
    ...overrides,
  };
}

function completionResponse(text = "done"): Response {
  const chunk = {
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: 0,
    choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
  };
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream", "x-test-response": text },
  });
}

const unsupportedControls = {
  store: false,
  max_tokens: 123,
  max_completion_tokens: 456,
  reasoning_budget: 789,
  reasoning_effort: "high",
  enable_thinking: false,
};

describe("PI NVIDIA request-local payload customization", () => {
  test("overlapping NVIDIA and non-NVIDIA streams keep fetch and payload hooks isolated", async () => {
    const originalFetch = globalThis.fetch;
    const allRequestsStarted = Promise.withResolvers<void>();
    const observations: Array<{
      label: string;
      url: string;
      body: Record<string, unknown>;
      header: string | null;
      fetchUnchanged: boolean;
    }> = [];
    const payloadObservations: Array<{ label: string; model: string; fetchUnchanged: boolean }> =
      [];
    const responseObservations: Array<{ label: string; status: number; value?: string }> = [];
    const callerPayloads: Array<Record<string, unknown>> = [];

    const turns = ["nvidia-replace", "nvidia-mutate", "other"].map(async (label) => {
      const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
        observations.push({
          label,
          url: String(input),
          body: JSON.parse(String(init?.body)),
          header: new Headers(init?.headers).get("x-test-request"),
          fetchUnchanged: globalThis.fetch === originalFetch,
        });
        if (observations.length === 3) allRequestsStarted.resolve();
        // Hold every request open until both providers and both NVIDIA calls
        // overlap, without using the network or changing global fetch in tests.
        await allRequestsStarted.promise;
        return completionResponse(label);
      }) as typeof fetch;
      const streamOptions: ProviderStreamOptions = {
        fetch: fetchImpl,
        headers: { "x-test-request": label },
        onPayload: async (payload, model) => {
          await Promise.resolve();
          payloadObservations.push({
            label,
            model: model.id,
            fetchUnchanged: globalThis.fetch === originalFetch,
          });
          const extras = {
            ...unsupportedControls,
            custom_request: label,
            chat_template_kwargs: { preserve: label, enable_thinking: false },
          };
          if (label === "nvidia-mutate") {
            Object.assign(payload as Record<string, unknown>, extras);
            callerPayloads.push(payload as Record<string, unknown>);
            return undefined;
          }
          const replacement = { ...(payload as Record<string, unknown>), ...extras };
          callerPayloads.push(replacement);
          return replacement;
        },
        onResponse: async (response) => {
          await Promise.resolve();
          responseObservations.push({
            label,
            status: response.status,
            value: response.headers["x-test-response"],
          });
        },
      };
      return await createPiRuntime().runTurn(
        makeParams(label === "other" ? "opencode-go" : "nvidia", streamOptions),
      );
    });

    const results = await Promise.all(turns);
    expect(globalThis.fetch).toBe(originalFetch);
    expect(observations).toHaveLength(3);
    expect(payloadObservations).toHaveLength(3);
    expect(responseObservations).toHaveLength(3);
    for (const observation of observations) {
      expect(observation.fetchUnchanged).toBe(true);
      expect(observation.header).toBe(observation.label);
      expect(observation.body.custom_request).toBe(observation.label);
      if (observation.label === "other") {
        expect(observation.url).toBe("https://opencode.ai/zen/go/v1/chat/completions");
        expect(observation.body).toMatchObject(unsupportedControls);
        expect(observation.body.chat_template_kwargs).toEqual({
          preserve: "other",
          enable_thinking: false,
        });
      } else {
        expect(observation.url).toBe("https://integrate.api.nvidia.com/v1/chat/completions");
        for (const key of Object.keys(unsupportedControls)) {
          expect(observation.body).not.toHaveProperty(key);
        }
        expect(observation.body.chat_template_kwargs).toEqual({
          preserve: observation.label,
          enable_thinking: true,
        });
      }
    }
    for (const observation of payloadObservations) {
      expect(observation.fetchUnchanged).toBe(true);
      expect(observation.model).toBe(
        observation.label === "other" ? "glm-5" : "nvidia/nemotron-3-super-120b-a12b",
      );
    }
    for (const observation of responseObservations) {
      expect(observation.status).toBe(200);
      expect(observation.value).toBe(observation.label);
    }
    // NVIDIA normalization must not mutate objects retained by caller hooks.
    for (const payload of callerPayloads) {
      expect(payload).toMatchObject(unsupportedControls);
      expect(payload.chat_template_kwargs).toMatchObject({ enable_thinking: false });
    }
    expect(results.map((result) => result.text)).toEqual([
      "nvidia-replace",
      "nvidia-mutate",
      "other",
    ]);
    for (const result of results) {
      expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 2, totalTokens: 12 });
    }
  });

  test("preserves cancellation during an asynchronous caller payload transform", async () => {
    const controller = new AbortController();
    const fetchImpl = mock(async () => completionResponse());
    const onModelAbort = mock(() => {});
    const onModelError = mock(() => {});
    const onResponse = mock(() => {});
    const originalFetch = globalThis.fetch;

    await expect(
      createPiRuntime().runTurn(
        makeParams(
          "nvidia",
          {
            fetch: fetchImpl as unknown as typeof fetch,
            onPayload: async () => {
              await Promise.resolve();
              controller.abort();
            },
            onResponse,
          },
          { abortSignal: controller.signal, onModelAbort, onModelError },
        ),
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(onResponse).not.toHaveBeenCalled();
    expect(onModelAbort).toHaveBeenCalledTimes(1);
    expect(onModelError).not.toHaveBeenCalled();
    expect(globalThis.fetch).toBe(originalFetch);
  });

  test("preserves asynchronous caller payload-transform failures", async () => {
    const fetchImpl = mock(async () => completionResponse());
    const onModelError = mock(() => {});
    const originalFetch = globalThis.fetch;

    await expect(
      createPiRuntime().runTurn(
        makeParams(
          "nvidia",
          {
            fetch: fetchImpl as unknown as typeof fetch,
            onPayload: async () => {
              await Promise.resolve();
              throw new Error("Caller rejected payload");
            },
          },
          { onModelError },
        ),
      ),
    ).rejects.toThrow("Caller rejected payload");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(onModelError).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch).toBe(originalFetch);
  });
});
