import { describe, expect, test } from "bun:test";
import path from "node:path";

import {
  buildTestInvocation,
  MACOS_TEST_BATCH_SIZE,
  partitionTestFiles,
} from "../scripts/run_tests";

const repoRoot = path.join(path.parse(import.meta.dir).root, "workspace", "agent-coworker");
const bunPath = path.join(path.parse(import.meta.dir).root, "runtime", "bun");

describe("project test runner", () => {
  test.each(["win32", "linux"] as const)("preserves direct Bun test behavior on %s", (platform) => {
    expect(
      buildTestInvocation({
        platform,
        repoRoot,
        bunPath,
        args: ["test/example.test.ts", "--timeout", "1000"],
      }),
    ).toEqual({
      command: [bunPath, "test", "test/example.test.ts", "--timeout", "1000"],
      cwd: repoRoot,
    });
  });

  test("runs macOS tests with the project bootstrap", () => {
    expect(
      buildTestInvocation({
        platform: "darwin",
        repoRoot,
        bunPath,
        args: ["test/example.test.ts", "--timeout", "1000"],
      }),
    ).toEqual({
      command: [
        bunPath,
        "test",
        "--isolate",
        "--preload",
        path.join(repoRoot, "test", "bun-test-bootstrap.ts"),
        path.join(repoRoot, "test", "example.test.ts"),
        "--timeout",
        "1000",
      ],
      cwd: repoRoot,
    });
  });

  test("uses explicit project test roots for a complete macOS run", () => {
    const invocation = buildTestInvocation({
      platform: "darwin",
      repoRoot,
      bunPath,
      args: [],
    });

    expect(invocation.command.slice(-2)).toEqual([
      path.join(repoRoot, "test"),
      path.join(repoRoot, "apps", "desktop", "test"),
    ]);
  });

  test("runs each macOS test file in a fresh Bun canary process", () => {
    const testFiles = Array.from({ length: 3 }, (_, index) => `test/case-${index}.test.ts`);

    expect(
      partitionTestFiles(testFiles, MACOS_TEST_BATCH_SIZE).map((batch) => batch.length),
    ).toEqual([1, 1, 1]);
  });
});
