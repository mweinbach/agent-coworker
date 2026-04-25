import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const workflowPath = new URL("../.github/workflows/ci.yml", import.meta.url);
const stableTestRunnerPath = new URL("../packages/harness/src/run_tests_stable.ts", import.meta.url);
const workflow = readFileSync(workflowPath, "utf8");
const stableTestRunner = readFileSync(stableTestRunnerPath, "utf8");

describe("main CI workflow", () => {
  test("pins Bun version via .bun-version file", () => {
    expect(workflow).toContain("- name: Setup Bun");
    expect(workflow).toContain("uses: oven-sh/setup-bun@v2");
    expect(workflow).toContain('bun-version-file: ".bun-version"');
  });

  test("caches dependencies", () => {
    expect(workflow).toContain("uses: actions/cache@v4");
    expect(workflow).toContain("node_modules");
    expect(workflow).toContain("apps/desktop/node_modules");
    expect(workflow).not.toContain("apps/mobile/node_modules");
    expect(workflow).toContain("~/.bun/install/cache");
    expect(workflow).toContain("${{ runner.os }}-bun-${{ hashFiles('bun.lock') }}");
  });

  test("keeps the core reliability guardrails", () => {
    expect(workflow).toContain("- name: Docs consistency check");
    expect(workflow).toContain("run: bun run docs:check");
    expect(workflow).toContain("- name: Typecheck");
    expect(workflow).toContain("run: bun run typecheck");
    expect(workflow).toContain("- name: Unit tests");
    expect(workflow).toContain("run: bun run test:stable -- --max-concurrency 1");
    expect(workflow).not.toContain("- name: Stable per-file unit tests");
  });

  test("stable test runner discovers TypeScript and TSX test files", () => {
    expect(stableTestRunner).toContain('"test/**/*.test.ts"');
    expect(stableTestRunner).toContain('"test/**/*.test.tsx"');
    expect(stableTestRunner).toContain('"apps/**/test/**/*.test.ts"');
    expect(stableTestRunner).toContain('"apps/**/test/**/*.test.tsx"');
  });

  test("keeps remote MCP smoke opt-in via secrets-backed environment", () => {
    expect(workflow).toContain('RUN_REMOTE_MCP_TESTS: "1"');
    expect(workflow).toContain("OPENCODE_API_KEY: ${{ secrets.OPENCODE_API_KEY }}");
    expect(workflow).toContain("run: bun test test/mcp.remote.grep.test.ts");
  });

  test("skips remote MCP smoke on fork pull requests", () => {
    expect(workflow).toContain(
      "if: github.event_name != 'pull_request' || !github.event.pull_request.head.repo.fork",
    );
  });
});
