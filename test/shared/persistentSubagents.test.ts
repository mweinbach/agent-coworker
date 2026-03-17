import { describe, expect, test } from "bun:test";

import { persistentAgentSummarySchema } from "../../src/shared/persistentSubagents";
import { PROVIDER_NAMES } from "../../src/types";

const BASE_SUMMARY = {
  agentId: "child-1",
  parentSessionId: "root-1",
  role: "worker" as const,
  mode: "collaborative" as const,
  depth: 1,
  title: "Child Session",
  effectiveModel: "gpt-5.2",
  createdAt: "2026-03-12T00:00:00.000Z",
  updatedAt: "2026-03-12T00:00:01.000Z",
  lifecycleState: "active" as const,
  executionState: "running" as const,
  busy: false,
};

describe("persistentAgentSummarySchema", () => {
  test("accepts every shared provider name", () => {
    for (const provider of PROVIDER_NAMES) {
      const parsed = persistentAgentSummarySchema.parse({
        ...BASE_SUMMARY,
        provider,
      });

      expect(parsed.provider).toBe(provider);
    }
  });

  test("rejects unknown providers", () => {
    expect(() =>
      persistentAgentSummarySchema.parse({
        ...BASE_SUMMARY,
        provider: "azure-openai",
      }),
    ).toThrow();
  });
});
