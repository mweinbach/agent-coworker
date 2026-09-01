import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  BedrockRuntimeClient,
  type ConverseStreamCommand,
  type ConverseStreamCommandOutput,
  type ConverseStreamOutput,
} from "@aws-sdk/client-bedrock-runtime";
import type { AssistantMessageEvent, Model } from "@earendil-works/pi-ai";
import * as nodeHttpHandler from "@smithy/node-http-handler";
import * as proxyAgent from "proxy-agent";

import {
  __internal as bedrockProviderModuleInternals,
  streamBedrock,
} from "../src/runtime/bedrockProviderModule";
import {
  modelMessagesToPiMessages,
  piTurnMessagesToModelMessages,
} from "../src/runtime/piMessageBridge";

const {
  buildAdditionalModelRequestFields,
  getStandardBedrockEndpointRegion,
  shouldUseExplicitBedrockEndpoint,
} = bedrockProviderModuleInternals;

const model: Model<"bedrock-converse-stream"> = {
  id: "anthropic.claude-sonnet-4-6",
  name: "Test Claude",
  api: "bedrock-converse-stream",
  provider: "amazon-bedrock",
  baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 4096,
};

const completeEvents: ConverseStreamOutput[] = [
  { messageStart: { role: "assistant" } },
  { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "Complete answer" } } },
  { contentBlockStop: { contentBlockIndex: 0 } },
  { messageStop: { stopReason: "end_turn" } },
];

function mockClient(events: ConverseStreamOutput[], streamError?: Error) {
  const response: ConverseStreamCommandOutput = {
    $metadata: { httpStatusCode: 200 },
    stream: {
      async *[Symbol.asyncIterator]() {
        yield* events;
        if (streamError) throw streamError;
      },
    },
  };
  return {
    send: spyOn(BedrockRuntimeClient.prototype, "send").mockResolvedValue(response as never),
    destroy: spyOn(BedrockRuntimeClient.prototype, "destroy"),
  };
}

async function collect(stream: ReturnType<typeof streamBedrock>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const events: AssistantMessageEvent[] = [];
        for await (const event of stream) events.push(event);
        return { events, result: await stream.result() };
      })(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Bedrock stream did not settle")), 1000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

afterEach(() => mock.restore());

describe("runtime/bedrockProviderModule", () => {
  test("completes a valid stream and releases its request-owned client", async () => {
    const { destroy } = mockClient(completeEvents);
    const { events, result } = await collect(streamBedrock(model, { messages: [] }));

    expect(result.stopReason).toBe("stop");
    expect(result.content).toEqual([{ type: "text", text: "Complete answer" }]);
    expect(events.filter((event) => event.type === "done")).toHaveLength(1);
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  test.each(["empty", "partial", "unclosed"] as const)(
    "rejects an incomplete %s stream",
    async (kind) => {
      const incompleteEvents = kind === "empty" ? [] : completeEvents.slice(0, 2);
      if (kind === "unclosed") incompleteEvents.push({ messageStop: { stopReason: "end_turn" } });
      const { destroy } = mockClient(incompleteEvents);
      const { events, result } = await collect(streamBedrock(model, { messages: [] }));

      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).toContain(
        kind === "unclosed" ? "contentBlockStop" : "messageStop",
      );
      expect(events.some((event) => event.type === "done")).toBe(false);
      expect(result.content).toEqual(
        kind === "empty" ? [] : [{ type: "text", text: "Complete answer" }],
      );
      expect(destroy).toHaveBeenCalledTimes(1);
    },
  );

  test.each([false, true])(
    "settles cleanup failures without masking a provider error (%s)",
    async (providerFails) => {
      const { send, destroy } = mockClient(completeEvents);
      if (providerFails) send.mockRejectedValue(new Error("Provider failed") as never);
      destroy.mockImplementation(() => {
        throw new Error("Cleanup failed");
      });

      const { events, result } = await collect(streamBedrock(model, { messages: [] }));
      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).toBe(providerFails ? "Provider failed" : "Cleanup failed");
      expect(events.filter((event) => event.type === "error")).toHaveLength(1);
      expect(events.some((event) => event.type === "done")).toBe(false);
    },
  );

  test.each(["send", "payload", "response", "stream", "abort"] as const)(
    "settles %s failures and releases the client",
    async (phase) => {
      const failure = new Error(`Failure during ${phase}`);
      const { send, destroy } = mockClient(
        completeEvents,
        phase === "stream" ? failure : undefined,
      );
      if (phase === "send") send.mockRejectedValue(failure as never);
      const controller = new AbortController();
      const { events, result } = await collect(
        streamBedrock(
          model,
          { messages: [] },
          {
            signal: controller.signal,
            onPayload: () => {
              if (phase === "payload") throw failure;
            },
            onResponse: () => {
              if (phase === "response") throw failure;
              if (phase === "abort") controller.abort();
            },
          },
        ),
      );

      expect(result.stopReason).toBe(phase === "abort" ? "aborted" : "error");
      expect(events.filter((event) => event.type === "error")).toHaveLength(1);
      expect(events.some((event) => event.type === "done")).toBe(false);
      expect(destroy).toHaveBeenCalledTimes(1);
    },
  );

  test("settles transport setup failures and releases an already-created proxy agent", async () => {
    const previousProxy = process.env.HTTP_PROXY;
    process.env.HTTP_PROXY = "http://proxy.invalid:8080";
    const destroy = mock(() => {});
    spyOn(proxyAgent, "ProxyAgent").mockImplementation(
      () => ({ destroy }) as unknown as proxyAgent.ProxyAgent,
    );
    spyOn(nodeHttpHandler, "NodeHttpHandler").mockImplementation(() => {
      throw new Error("Transport setup failed");
    });

    try {
      const { events, result } = await collect(streamBedrock(model, { messages: [] }));
      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).toBe("Transport setup failed");
      expect(events.filter((event) => event.type === "error")).toHaveLength(1);
      expect(destroy).toHaveBeenCalledTimes(1);
    } finally {
      if (previousProxy === undefined) delete process.env.HTTP_PROXY;
      else process.env.HTTP_PROXY = previousProxy;
    }
  });

  test("preserves redacted reasoning bytes through streaming, persistence, and Bedrock replay", async () => {
    const opaqueBytes = new Uint8Array([1, 2, 3, 4]);
    const { send } = mockClient([
      { messageStart: { role: "assistant" } },
      {
        contentBlockDelta: {
          contentBlockIndex: 0,
          delta: { reasoningContent: { text: "Signed reasoning" } },
        },
      },
      {
        contentBlockDelta: {
          contentBlockIndex: 0,
          delta: { reasoningContent: { signature: "signed-reasoning" } },
        },
      },
      { contentBlockStop: { contentBlockIndex: 0 } },
      {
        contentBlockDelta: {
          contentBlockIndex: 1,
          delta: { reasoningContent: { redactedContent: opaqueBytes.slice(0, 2) } },
        },
      },
      {
        contentBlockDelta: {
          contentBlockIndex: 1,
          delta: { reasoningContent: { redactedContent: opaqueBytes.slice(2) } },
        },
      },
      { contentBlockStop: { contentBlockIndex: 1 } },
      { contentBlockDelta: { contentBlockIndex: 2, delta: { text: "Answer" } } },
      { contentBlockStop: { contentBlockIndex: 2 } },
      { messageStop: { stopReason: "end_turn" } },
    ]);
    const { result } = await collect(
      streamBedrock(model, { messages: [] }, { cacheRetention: "none" }),
    );
    expect(result.content).toEqual([
      { type: "thinking", thinking: "Signed reasoning", thinkingSignature: "signed-reasoning" },
      { type: "thinking", thinking: "", thinkingSignature: "AQIDBA==", redacted: true },
      { type: "text", text: "Answer" },
    ]);

    const persisted = JSON.parse(JSON.stringify(piTurnMessagesToModelMessages([result])));
    await collect(
      streamBedrock(
        model,
        {
          messages: modelMessagesToPiMessages(persisted, "bedrock"),
        },
        { cacheRetention: "none" },
      ),
    );
    const command = send.mock.calls[1]?.[0] as ConverseStreamCommand | undefined;
    expect(command?.input.messages?.[0]?.content).toEqual([
      {
        reasoningContent: {
          reasoningText: { text: "Signed reasoning", signature: "signed-reasoning" },
        },
      },
      { reasoningContent: { redactedContent: opaqueBytes } },
      { text: "Answer" },
    ]);
  });

  test("extracts regions only from standard Bedrock runtime endpoints", () => {
    expect(
      getStandardBedrockEndpointRegion("https://bedrock-runtime.us-east-1.amazonaws.com"),
    ).toBe("us-east-1");
    expect(
      getStandardBedrockEndpointRegion("https://bedrock-runtime-fips.us-gov-west-1.amazonaws.com"),
    ).toBe("us-gov-west-1");
    expect(
      getStandardBedrockEndpointRegion("https://bedrock-runtime.cn-north-1.amazonaws.com.cn"),
    ).toBe("cn-north-1");
    expect(getStandardBedrockEndpointRegion("https://custom-bedrock.example.test")).toBeUndefined();
    expect(getStandardBedrockEndpointRegion("not a url")).toBeUndefined();
    expect(getStandardBedrockEndpointRegion(undefined)).toBeUndefined();
  });

  test("uses explicit endpoints only when SDK default resolution cannot safely infer intent", () => {
    expect(
      shouldUseExplicitBedrockEndpoint(
        "https://bedrock-runtime.us-west-2.amazonaws.com",
        undefined,
        false,
      ),
    ).toBe(true);
    expect(
      shouldUseExplicitBedrockEndpoint(
        "https://bedrock-runtime.us-west-2.amazonaws.com",
        "us-east-1",
        false,
      ),
    ).toBe(false);
    expect(
      shouldUseExplicitBedrockEndpoint(
        "https://bedrock-runtime.us-west-2.amazonaws.com",
        undefined,
        true,
      ),
    ).toBe(false);
    expect(
      shouldUseExplicitBedrockEndpoint(
        "https://bedrock-runtime.internal.example.test",
        "us-east-1",
        true,
      ),
    ).toBe(true);
  });

  test("omits unsupported thinking display for GovCloud Claude targets", () => {
    const fields = buildAdditionalModelRequestFields(
      {
        id: "anthropic.claude-sonnet-4-5-20250929-v1:0",
        reasoning: true,
      },
      {
        reasoning: "high",
        region: "us-gov-west-1",
      },
    );

    expect(fields).toEqual({
      thinking: {
        type: "enabled",
        budget_tokens: 16384,
      },
      anthropic_beta: ["interleaved-thinking-2025-05-14"],
    });
  });

  test("defaults commercial Claude thinking display and maps adaptive xhigh by model generation", () => {
    expect(
      buildAdditionalModelRequestFields(
        {
          id: "anthropic.claude-opus-4-6-20260115-v1:0",
          reasoning: true,
        },
        {
          reasoning: "xhigh",
        },
      ),
    ).toEqual({
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "max" },
    });

    expect(
      buildAdditionalModelRequestFields(
        {
          id: "anthropic.claude-opus-4-7-20260415-v1:0",
          reasoning: true,
        },
        {
          reasoning: "xhigh",
          thinkingDisplay: "full",
        },
      ),
    ).toEqual({
      thinking: { type: "adaptive", display: "full" },
      output_config: { effort: "xhigh" },
    });
  });
});
