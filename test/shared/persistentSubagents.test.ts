import { describe, expect, test } from "bun:test";

import { persistentSubagentSummarySchema } from "../../src/shared/persistentSubagents";
import { PROVIDER_NAMES } from "../../src/types";

const BASE_SUMMARY = {
  sessionId: "child-1",
  parentSessionId: "root-1",
  agentType: "general" as const,
  title: "Child Session",
  model: "gpt-5.2",
  createdAt: "2026-03-12T00:00:00.000Z",
  updatedAt: "2026-03-12T00:00:01.000Z",
  status: "active" as const,
  busy: false,
};

describe("persistentSubagentSummarySchema", () => {
  test("accepts every shared provider name", () => {
    for (const provider of PROVIDER_NAMES) {
      const parsed = persistentSubagentSummarySchema.parse({
        ...BASE_SUMMARY,
        provider,
      });

      expect(parsed.provider).toBe(provider);
    }
  });

  test("rejects unknown providers", () => {
    expect(() =>
      persistentSubagentSummarySchema.parse({
        ...BASE_SUMMARY,
        provider: "azure-openai",
      }),
    ).toThrow();
  });
});
