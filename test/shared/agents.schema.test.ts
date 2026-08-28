import { describe, expect, test } from "bun:test";

import {
  childAgentReportSchema,
  mapLegacyAgentTypeToRole,
  normalizeAgentTargetPaths,
  resolveAgentSpawnContextOptions,
} from "../../src/shared/agents";

describe("normalizeAgentTargetPaths", () => {
  test("returns undefined for missing input and trims plus dedupes paths", () => {
    expect(normalizeAgentTargetPaths(undefined)).toBeUndefined();
    expect(normalizeAgentTargetPaths(null)).toBeUndefined();
    expect(normalizeAgentTargetPaths([" src ", "docs", "src", " docs "])).toEqual(["src", "docs"]);
  });

  test("throws when any entry is empty after trim", () => {
    expect(() => normalizeAgentTargetPaths(["src", "  "])).toThrow(
      "targetPaths entries must not be empty",
    );
    expect(() => normalizeAgentTargetPaths([""])).toThrow("targetPaths entries must not be empty");
  });
});

describe("resolveAgentSpawnContextOptions", () => {
  test("defaults to none unless forkContext requests a full fork", () => {
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
  });

  test("requires a non-empty briefing in brief mode and only keeps explicit flags", () => {
    expect(() => resolveAgentSpawnContextOptions({ contextMode: "brief" })).toThrow(
      'briefing is required when contextMode is "brief"',
    );
    expect(() =>
      resolveAgentSpawnContextOptions({ contextMode: "brief", briefing: "   " }),
    ).toThrow('briefing is required when contextMode is "brief"');

    expect(
      resolveAgentSpawnContextOptions({
        contextMode: "brief",
        briefing: "  inspect auth  ",
        includeParentTodos: true,
        includeHarnessContext: true,
      }),
    ).toEqual({
      contextMode: "brief",
      briefing: "inspect auth",
      includeParentTodos: true,
      includeHarnessContext: true,
    });
  });
});

describe("mapLegacyAgentTypeToRole", () => {
  test("maps known legacy types and fails closed on current or unknown roles", () => {
    expect(mapLegacyAgentTypeToRole("explore")).toBe("explorer");
    expect(mapLegacyAgentTypeToRole("research")).toBe("research");
    expect(mapLegacyAgentTypeToRole("general")).toBe("worker");
    expect(mapLegacyAgentTypeToRole("explorer")).toBeNull();
    expect(mapLegacyAgentTypeToRole("worker")).toBeNull();
    expect(mapLegacyAgentTypeToRole("unknown")).toBeNull();
    expect(mapLegacyAgentTypeToRole("")).toBeNull();
    expect(mapLegacyAgentTypeToRole(null)).toBeNull();
    expect(mapLegacyAgentTypeToRole(undefined)).toBeNull();
  });
});

describe("childAgentReportSchema", () => {
  test("accepts a minimal completed report and a full valid report", () => {
    expect(childAgentReportSchema.parse({ status: "completed", summary: "done" })).toEqual({
      status: "completed",
      summary: "done",
    });

    expect(
      childAgentReportSchema.parse({
        status: "blocked",
        summary: " waiting on review ",
        filesChanged: ["src/a.ts"],
        filesRead: ["docs/x.md"],
        verification: [{ command: "bun test", outcome: "passed", notes: "green" }],
        residualRisks: ["flaky env"],
      }),
    ).toMatchObject({
      status: "blocked",
      summary: "waiting on review",
    });
  });

  test("rejects empty summaries, blank nested strings, extra keys, and unknown outcomes", () => {
    expect(childAgentReportSchema.safeParse({ status: "completed", summary: "  " }).success).toBe(
      false,
    );
    expect(
      childAgentReportSchema.safeParse({
        status: "failed",
        summary: "broke",
        extra: true,
      }).success,
    ).toBe(false);
    expect(
      childAgentReportSchema.safeParse({
        status: "completed",
        summary: "ok",
        filesChanged: [""],
      }).success,
    ).toBe(false);
    expect(
      childAgentReportSchema.safeParse({
        status: "completed",
        summary: "ok",
        verification: [{ command: "bun test", outcome: "skipped" }],
      }).success,
    ).toBe(false);
    expect(
      childAgentReportSchema.safeParse({
        status: "completed",
        summary: "ok",
        verification: [{ command: "bun test", outcome: "passed", unexpected: 1 }],
      }).success,
    ).toBe(false);
  });
});
