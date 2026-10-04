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
    for (const schema of [
      strictObject,
      {
        type: "object",
        additionalProperties: false,
        properties: {
          item: strictObject,
          tags: { type: "array", items: { type: "string" } },
        },
        required: ["item", "tags"],
      },
      {
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
      },
    ]) {
      expect(supportsConstrainedJsonSchema(schema)).toBe(true);
    }
  });

  test("rejects optional fields, open objects, and disallowed keywords", () => {
    for (const schema of [
      {
        ...strictObject,
        properties: { text: { type: "string" }, extra: { type: "string" } },
      },
      { ...strictObject, additionalProperties: true },
      { ...strictObject, properties: { text: { type: "string", pattern: "^[a-z]+$" } } },
      { ...strictObject, properties: { text: { $ref: "#/$defs/text" } } },
      { ...strictObject, minimum: 1 },
    ]) {
      expect(supportsConstrainedJsonSchema(schema)).toBe(false);
    }
  });

  test("rejects non-object roots, empty unions, and unsafe nested arrays", () => {
    const cyclic: Record<string, unknown> = {
      type: "object",
      additionalProperties: false,
      required: ["self"],
    };
    cyclic.properties = { self: cyclic };

    for (const schema of [
      null,
      { type: "array", items: strictObject },
      { type: "object", anyOf: [] },
      {
        type: "object",
        additionalProperties: false,
        properties: { items: { type: "array", items: { $ref: "#/$defs/item" } } },
        required: ["items"],
      },
      cyclic,
    ]) {
      expect(supportsConstrainedJsonSchema(schema)).toBe(false);
    }
  });
});
