import { describe, expect, test } from "bun:test";

import { supportsConstrainedJsonSchema } from "../src/runtime/constrainedSampling";

const strictObject = {
  type: "object",
  additionalProperties: false,
  properties: { text: { type: "string" } },
  required: ["text"],
} as const;

describe("supportsConstrainedJsonSchema", () => {
  test("accepts a closed object whose required set matches its properties", () => {
    expect(supportsConstrainedJsonSchema(strictObject)).toBe(true);
    expect(
      supportsConstrainedJsonSchema({
        type: "object",
        additionalProperties: false,
        properties: {
          item: strictObject,
          tags: { type: "array", items: { type: "string" } },
        },
        required: ["item", "tags"],
      }),
    ).toBe(true);
    expect(
      supportsConstrainedJsonSchema({
        type: "object",
        anyOf: [
          strictObject,
          {
            type: "object",
            additionalProperties: false,
            properties: { count: { type: "integer" } },
            required: ["count"],
          },
        ],
      }),
    ).toBe(true);
  });

  test("rejects optional fields, open objects, and disallowed keywords", () => {
    expect(
      supportsConstrainedJsonSchema({
        type: "object",
        additionalProperties: false,
        properties: { text: { type: "string" }, extra: { type: "string" } },
        required: ["text"],
      }),
    ).toBe(false);
    expect(
      supportsConstrainedJsonSchema({
        type: "object",
        additionalProperties: true,
        properties: { text: { type: "string" } },
        required: ["text"],
      }),
    ).toBe(false);
    expect(
      supportsConstrainedJsonSchema({
        ...strictObject,
        properties: { text: { type: "string", pattern: "^[a-z]+$" } },
      }),
    ).toBe(false);
    expect(
      supportsConstrainedJsonSchema({
        ...strictObject,
        properties: { text: { $ref: "#/$defs/text" } },
      }),
    ).toBe(false);
    expect(supportsConstrainedJsonSchema({ ...strictObject, minimum: 1 })).toBe(false);
  });

  test("rejects non-object roots, empty unions, and unsafe nested arrays", () => {
    expect(supportsConstrainedJsonSchema(null)).toBe(false);
    expect(supportsConstrainedJsonSchema({ type: "array", items: strictObject })).toBe(false);
    expect(supportsConstrainedJsonSchema({ type: "object", anyOf: [] })).toBe(false);
    expect(
      supportsConstrainedJsonSchema({
        type: "object",
        additionalProperties: false,
        properties: {
          items: { type: "array", items: { $ref: "#/$defs/item" } },
        },
        required: ["items"],
      }),
    ).toBe(false);
    const cyclic: Record<string, unknown> = {
      type: "object",
      additionalProperties: false,
      required: ["self"],
    };
    cyclic.properties = { self: cyclic };
    expect(supportsConstrainedJsonSchema(cyclic)).toBe(false);
  });
});
