import { describe, expect, test } from "bun:test";
import { extractResultEnvelope, validateAgainstJsonSchema } from "../../src/workflows/resultSchema";

const objectSchema = {
  type: "object",
  additionalProperties: false,
  required: ["n"],
  properties: { n: { type: "number" } },
};

describe("extractResultEnvelope", () => {
  test("extracts the last non-empty workflow_result body and fails closed on empty/missing envelopes", () => {
    expect(
      extractResultEnvelope('prefix <workflow_result>{"n": 1}</workflow_result> trailing'),
    ).toBe('{"n": 1}');
    expect(
      extractResultEnvelope(
        '<workflow_result>{"n": 1}</workflow_result>\n<workflow_result>{"n": 2}</workflow_result>',
      ),
    ).toBe('{"n": 2}');
    expect(extractResultEnvelope('<workflow_result>\n{"n": 3}\n')).toBe('{"n": 3}');

    for (const empty of [
      null,
      undefined,
      "no envelope here",
      "<workflow_result>   </workflow_result>",
      "<workflow_result></workflow_result>",
    ]) {
      expect(extractResultEnvelope(empty)).toBeNull();
    }
  });
});

describe("validateAgainstJsonSchema", () => {
  test("validates envelopes, reports JSON/schema issues without repairing, and throws on malformed schemas", () => {
    expect(validateAgainstJsonSchema(objectSchema, null)).toEqual({
      ok: false,
      issues: ["no <workflow_result> block was found in the final message"],
    });
    const badJson = validateAgainstJsonSchema(objectSchema, "{");
    expect(badJson).toMatchObject({ ok: false });
    if (!badJson.ok) expect(badJson.issues[0]).toMatch(/the block was not valid JSON/);

    expect(validateAgainstJsonSchema(objectSchema, '{"n": 7}')).toEqual({
      ok: true,
      value: { n: 7 },
    });

    for (const [raw, match] of [
      ['{"n": 7, "extra": true}', (i: string) => i.includes("extra")],
      ['{"n": "seven"}', (i: string) => i.startsWith("n:")],
      ["{}", (i: string) => /n/.test(i)],
    ] as const) {
      const res = validateAgainstJsonSchema(objectSchema, raw);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.issues.some(match)).toBe(true);
    }

    expect(() => validateAgainstJsonSchema({ type: "not-a-json-schema-type" }, '{"n": 1}')).toThrow(
      /workflow agent schema is not a usable JSON Schema/,
    );
  });
});
