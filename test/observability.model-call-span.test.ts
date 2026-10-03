import { describe, expect, spyOn, test } from "bun:test";
import {
  type AttributeValue,
  INVALID_SPAN_CONTEXT,
  type Span,
  type SpanStatus,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";

import {
  markModelCallSpanSuccessFromAssistantRecord,
  markModelCallSpanSuccessFromTextAndUsage,
  parseTelemetrySettings,
  startCodexModelCallSpan,
  startPiModelCallSpan,
} from "../src/observability/modelCallSpan";
import type { RuntimeRunTurnParams } from "../src/runtime/types";

const SECRET = "sk-synthetic-model-secret";

function turnParams(): RuntimeRunTurnParams {
  return {
    config: { provider: "openai" },
    system: `system prompt ${SECRET}`,
  } as RuntimeRunTurnParams;
}

function captureStartedSpan() {
  const tracer = trace.getTracer("model-call-span-test");
  const startSpan = spyOn(tracer, "startSpan").mockReturnValue(
    trace.wrapSpanContext(INVALID_SPAN_CONTEXT),
  );
  const getTracer = spyOn(trace, "getTracer").mockReturnValue(tracer);
  return {
    startSpan,
    restore() {
      getTracer.mockRestore();
      startSpan.mockRestore();
    },
    attributes(): Record<string, AttributeValue> | undefined {
      return startSpan.mock.calls[0]?.[1]?.attributes;
    },
  };
}

function makeSpan() {
  const captured = {
    status: undefined as SpanStatus | undefined,
    attributes: {} as Record<string, AttributeValue>,
    ended: false,
  };
  const span = {
    setStatus(status: SpanStatus) {
      captured.status = status;
    },
    setAttribute(key: string, value: AttributeValue) {
      captured.attributes[key] = value;
    },
    end() {
      captured.ended = true;
    },
  };
  return { span: span as unknown as Span, captured };
}

describe("model-call telemetry consent", () => {
  test("parseTelemetrySettings enables recording only for strict booleans and finite metadata", () => {
    expect(parseTelemetrySettings(null)).toBeUndefined();
    expect(parseTelemetrySettings({ isEnabled: false })).toBeUndefined();
    expect(parseTelemetrySettings({ isEnabled: "true", recordInputs: true })).toBeUndefined();
    expect(parseTelemetrySettings({ isEnabled: 1, recordOutputs: true })).toBeUndefined();

    expect(
      parseTelemetrySettings({
        isEnabled: true,
        recordInputs: "true",
        recordOutputs: 1,
        functionId: "   ",
        metadata: ["not-a-record"],
      }),
    ).toEqual({
      isEnabled: true,
      recordInputs: false,
      recordOutputs: false,
    });

    expect(
      parseTelemetrySettings({
        isEnabled: true,
        recordInputs: true,
        functionId: "  session.turn  ",
        metadata: {
          sessionId: "session-123",
          attempt: 0,
          enabled: false,
          missing: null,
          nested: { apiKey: SECRET },
          tags: [SECRET],
          ratio: Number.NaN,
          limit: Number.POSITIVE_INFINITY,
          debt: Number.NEGATIVE_INFINITY,
        },
      }),
    ).toEqual({
      isEnabled: true,
      recordInputs: true,
      recordOutputs: false,
      functionId: "session.turn",
      metadata: {
        sessionId: "session-123",
        attempt: 0,
        enabled: false,
      },
    });
  });

  test("disabled telemetry does not open a model-call span", () => {
    const captured = captureStartedSpan();
    try {
      expect(
        startPiModelCallSpan(undefined, turnParams(), "gpt-test", 1, { apiKey: SECRET }, []),
      ).toBeNull();
      expect(
        startCodexModelCallSpan({ isEnabled: false }, turnParams(), "gpt-test", 1, {
          prompt: SECRET,
        }),
      ).toBeNull();
      expect(captured.startSpan).not.toHaveBeenCalled();
    } finally {
      captured.restore();
    }
  });

  test("input attributes stay off unless recordInputs is exactly enabled", () => {
    const captured = captureStartedSpan();
    try {
      const options = { apiKey: SECRET, nested: { token: SECRET } };
      startPiModelCallSpan(
        { isEnabled: true, recordInputs: false, recordOutputs: true },
        turnParams(),
        "gpt-test",
        2,
        options,
        [{ role: "user", content: SECRET }],
      );
      startCodexModelCallSpan({ isEnabled: true }, turnParams(), "codex-test", 3, {
        system: SECRET,
        messages: [{ content: SECRET }],
      });

      expect(captured.startSpan).toHaveBeenCalledTimes(2);
      for (const call of captured.startSpan.mock.calls) {
        const attributes = call[1]?.attributes ?? {};
        const serialized = JSON.stringify(attributes);
        expect(serialized).not.toContain(SECRET);
        expect(attributes).not.toHaveProperty("llm.input.system");
        expect(attributes).not.toHaveProperty("llm.input.messages");
        expect(attributes).not.toHaveProperty("llm.input.options");
      }
      expect(options).toEqual({ apiKey: SECRET, nested: { token: SECRET } });
      expect(captured.startSpan.mock.calls[0]?.[1]?.attributes).toMatchObject({
        "llm.runtime": "pi",
        "llm.provider": "openai",
        "llm.model": "gpt-test",
        "llm.step_number": 2,
      });
      expect(captured.startSpan.mock.calls[1]?.[1]?.attributes).toMatchObject({
        "llm.runtime": "codex-app-server",
        "llm.model": "codex-test",
        "llm.step_number": 3,
      });
    } finally {
      captured.restore();
    }
  });

  test("successful spans keep token counts and omit response text without output consent", () => {
    const assistant = makeSpan();
    markModelCallSpanSuccessFromAssistantRecord(
      assistant.span,
      { isEnabled: true, recordOutputs: false },
      {
        stopReason: "stop",
        text: SECRET,
        usage: {
          input: Number.NaN,
          output: Number.POSITIVE_INFINITY,
          totalTokens: 0,
          cached: "12",
        },
      },
    );
    expect(assistant.captured.ended).toBe(true);
    expect(assistant.captured.status).toEqual({ code: SpanStatusCode.OK });
    expect(assistant.captured.attributes).toEqual({
      "llm.usage.total_tokens": 0,
    });
    expect(JSON.stringify(assistant.captured)).not.toContain(SECRET);

    const text = makeSpan();
    markModelCallSpanSuccessFromTextAndUsage(text.span, undefined, `assistant said ${SECRET}`, {
      promptTokens: 4,
      completionTokens: 5,
      totalTokens: 9,
      cachedPromptTokens: 0,
    });
    expect(text.captured.attributes).toEqual({
      "llm.usage.input_tokens": 4,
      "llm.usage.cached_input_tokens": 0,
      "llm.usage.output_tokens": 5,
      "llm.usage.total_tokens": 9,
    });
    expect(JSON.stringify(text.captured)).not.toContain(SECRET);

    expect(() =>
      markModelCallSpanSuccessFromAssistantRecord(
        null,
        { isEnabled: true, recordOutputs: true },
        {
          text: SECRET,
        },
      ),
    ).not.toThrow();
    expect(() =>
      markModelCallSpanSuccessFromTextAndUsage(null, undefined, SECRET, undefined),
    ).not.toThrow();
  });

  test("output consent records the response and still drops non-finite assistant usage", () => {
    const assistant = makeSpan();
    const record = {
      stopReason: "length",
      text: "bounded completion",
      usage: { input: 3, output: Number.NaN },
    };
    markModelCallSpanSuccessFromAssistantRecord(
      assistant.span,
      { isEnabled: true, recordInputs: true, recordOutputs: true },
      record,
    );
    expect(assistant.captured.attributes["llm.output.stop_reason"]).toBe("length");
    expect(String(assistant.captured.attributes["llm.output.response"])).toContain(
      "bounded completion",
    );
    expect(assistant.captured.attributes["llm.usage.input_tokens"]).toBe(3);
    expect(assistant.captured.attributes).not.toHaveProperty("llm.usage.output_tokens");

    const circular: Record<string, unknown> = { text: SECRET };
    circular.self = circular;
    const cycled = makeSpan();
    expect(() =>
      markModelCallSpanSuccessFromAssistantRecord(
        cycled.span,
        { isEnabled: true, recordOutputs: true },
        circular,
      ),
    ).not.toThrow();
    expect(JSON.stringify(cycled.captured)).not.toContain(SECRET);
    expect(cycled.captured.ended).toBe(true);
  });
});
