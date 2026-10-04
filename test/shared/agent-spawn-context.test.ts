import { describe, expect, test } from "bun:test";
import { jsonRpcAgentRequestSchemas } from "../../src/server/jsonrpc/schema.agents";
import {
  childAgentReportSchema,
  mapLegacyAgentTypeToRole,
  resolveAgentSpawnContextOptions,
} from "../../src/shared/agents";

const spawnSchema = jsonRpcAgentRequestSchemas["cowork/session/agent/spawn"];

describe("resolveAgentSpawnContextOptions", () => {
  test("defaults to none and maps deprecated forkContext only when contextMode is omitted", () => {
    expect(resolveAgentSpawnContextOptions(undefined)).toEqual({
      contextMode: "none",
      includeParentTodos: false,
      includeHarnessContext: false,
    });
    expect(resolveAgentSpawnContextOptions({ forkContext: true })).toEqual({
      contextMode: "full",
      includeParentTodos: false,
      includeHarnessContext: false,
    });
    expect(
      resolveAgentSpawnContextOptions({
        contextMode: "none",
        forkContext: true,
        includeParentTodos: true,
        includeHarnessContext: true,
      }),
    ).toEqual({
      contextMode: "none",
      includeParentTodos: true,
      includeHarnessContext: true,
    });
  });

  test("requires a non-blank briefing for brief mode and trims surviving briefings", () => {
    for (const bad of [
      { contextMode: "brief" as const },
      { contextMode: "brief" as const, briefing: "   " },
    ]) {
      expect(() => resolveAgentSpawnContextOptions(bad)).toThrow(
        'briefing is required when contextMode is "brief"',
      );
    }
    expect(
      resolveAgentSpawnContextOptions({ contextMode: "brief", briefing: "  Focus on auth  " }),
    ).toEqual({
      contextMode: "brief",
      briefing: "Focus on auth",
      includeParentTodos: false,
      includeHarnessContext: false,
    });
  });
});

describe("cowork/session/agent/spawn context schema", () => {
  test("rejects brief mode without a briefing before spawn runs", () => {
    expect(
      spawnSchema.safeParse({
        threadId: "thread-1",
        message: "Plan the change",
        contextMode: "brief",
      }).success,
    ).toBe(false);
    expect(
      spawnSchema.parse({
        threadId: " thread-1 ",
        message: " Plan the change ",
        contextMode: "brief",
        briefing: "  Focus on auth  ",
        forkContext: false,
      }),
    ).toMatchObject({
      threadId: "thread-1",
      message: "Plan the change",
      contextMode: "brief",
      briefing: "Focus on auth",
      forkContext: false,
    });
  });
});

describe("mapLegacyAgentTypeToRole", () => {
  test("maps retired aliases and fails closed for current or unknown roles", () => {
    expect(mapLegacyAgentTypeToRole("explore")).toBe("explorer");
    expect(mapLegacyAgentTypeToRole("research")).toBe("research");
    expect(mapLegacyAgentTypeToRole("general")).toBe("worker");
    for (const input of [undefined, null, "", "worker", "explorer", "bogus"]) {
      expect(mapLegacyAgentTypeToRole(input)).toBeNull();
    }
  });
});

describe("childAgentReportSchema", () => {
  test("accepts a complete report and rejects blank, extra, or unknown fields", () => {
    expect(
      childAgentReportSchema.parse({
        status: "completed",
        summary: " Done ",
        filesChanged: [" src/a.ts "],
        verification: [{ command: " bun test ", outcome: "passed" }],
      }),
    ).toEqual({
      status: "completed",
      summary: "Done",
      filesChanged: ["src/a.ts"],
      verification: [{ command: "bun test", outcome: "passed" }],
    });

    for (const invalid of [
      { status: "completed", summary: " " },
      { status: "done", summary: "ok" },
      { status: "completed", summary: "ok", extra: true },
      { status: "completed", summary: "ok", filesChanged: [" "] },
    ]) {
      expect(childAgentReportSchema.safeParse(invalid).success).toBe(false);
    }
  });
});
