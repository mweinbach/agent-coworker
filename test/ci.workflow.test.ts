import { readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

const workflowPath = new URL("../.github/workflows/ci.yml", import.meta.url);
const workflow = readFileSync(workflowPath, "utf8");

describe("main CI workflow", () => {
  test("keeps the core reliability guardrails in the main checks job", () => {
    expect(workflow).toContain("- name: Docs consistency check");
    expect(workflow).toContain("run: bun run docs:check");
    expect(workflow).toContain("- name: Typecheck");
    expect(workflow).toContain("run: bun run typecheck");
    expect(workflow).toContain("- name: Unit tests");
    expect(workflow).toContain("run: bun test --max-concurrency 1");
    expect(workflow).toContain("- name: Stable per-file unit tests");
    expect(workflow).toContain("run: bun run test:stable -- --max-concurrency 1");
  });

  test("runs the main guardrails in a predictable order before the optional remote smoke", () => {
    expect(workflow).toMatch(
      /- name: Docs consistency check[\s\S]*?run: bun run docs:check[\s\S]*?- name: Typecheck[\s\S]*?run: bun run typecheck[\s\S]*?- name: Unit tests[\s\S]*?run: bun test --max-concurrency 1[\s\S]*?- name: Stable per-file unit tests[\s\S]*?run: bun run test:stable -- --max-concurrency 1[\s\S]*?- name: Remote MCP smoke/,
    );
  });

  test("keeps remote MCP smoke opt-in via secrets-backed environment", () => {
    expect(workflow).toContain('RUN_REMOTE_MCP_TESTS: "1"');
    expect(workflow).toContain("OPENCODE_API_KEY: ${{ secrets.OPENCODE_API_KEY }}");
    expect(workflow).toContain("run: bun test test/mcp.remote.grep.test.ts");
  });
});
