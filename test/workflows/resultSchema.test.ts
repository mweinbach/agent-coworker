import { describe, expect, test } from "bun:test";

import { extractResultEnvelope, validateAgainstJsonSchema } from "../../src/workflows/resultSchema";

const objectSchema = {
  type: "object",
  additionalProperties: false,
  required: ["n"],
  properties: {
    n: { type: "number" },
  },
};

describe("extractResultEnvelope", () => {
  test("returns the last workflow_result body and ignores surrounding prose", () => {
    expect(
      extractResultEnvelope('prefix <workflow_result>{"n": 1}</workflow_result> trailing'),
    ).toBe('{"n": 1}');
    expect(
      extractResultEnvelope(
        '<workflow_result>{"n": 1}</workflow_result>\n<workflow_result>{"n": 2}</workflow_result>',
      ),
    ).toBe('{"n": 2}');
  });

  test("an unclosed final block still yields its trimmed body", () => {
    expect(extractResultEnvelope('<workflow_result>\n{"n": 3}\n')).toBe('{"n": 3}');
  });

  test("missing, empty, or whitespace-only envelopes fail closed", () => {
    expect(extractResultEnvelope(null)).toBeNull();
    expect(extractResultEnvelope(undefined)).toBeNull();
    expect(extractResultEnvelope("no envelope here")).toBeNull();
    expect(extractResultEnvelope("<workflow_result>   </workflow_result>")).toBeNull();
    expect(extractResultEnvelope("<workflow_result></workflow_result>")).toBeNull();
  });
});

describe("validateAgainstJsonSchema", () => {
  test("rejects a missing envelope or invalid JSON without throwing", () => {
    expect(validateAgainstJsonSchema(objectSchema, null)).toEqual({
      ok: false,
      issues: ["no <workflow_result> block was found in the final message"],
    });
    expect(validateAgainstJsonSchema(objectSchema, "{")).toMatchObject({ ok: false });
    expect(validateAgainstJsonSchema(objectSchema, "{")?.issues[0]).toMatch(
      /the block was not valid JSON/,
    );
  });

  test("accepts a value that matches the caller schema", () => {
    expect(validateAgainstJsonSchema(objectSchema, '{"n": 7}')).toEqual({
      ok: true,
      value: { n: 7 },
    });
  });

  test("reports JSON Schema issues with paths instead of repairing them", () => {
    const extra = validateAgainstJsonSchema(objectSchema, '{"n": 7, "extra": true}');
    expect(extra.ok).toBe(false);
    if (!extra.ok) {
      expect(extra.issues.some((issue) => issue.includes("extra"))).toBe(true);
    }

    const wrongType = validateAgainstJsonSchema(objectSchema, '{"n": "seven"}');
    expect(wrongType.ok).toBe(false);
    if (!wrongType.ok) {
      expect(wrongType.issues.some((issue) => issue.startsWith("n:"))).toBe(true);
    }

    const missing = validateAgainstJsonSchema(objectSchema, "{}");
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.issues.some((issue) => /n/.test(issue))).toBe(true);
    }
  });

  test("a malformed caller schema throws instead of burning a repair turn", () => {
    expect(() => validateAgainstJsonSchema({ type: "not-a-json-schema-type" }, '{"n": 1}')).toThrow(
      /workflow agent schema is not a usable JSON Schema/,
    );
  });
});
