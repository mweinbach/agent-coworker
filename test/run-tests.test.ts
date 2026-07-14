import { describe, expect, test } from "bun:test";
import path from "node:path";

import {
  buildTestInvocation,
  formatFailureSummary,
  FULL_RUN_TEST_BATCH_SIZE,
  parseJUnitFailures,
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

  test("runs each full-suite test file in a fresh Bun canary process on every platform", () => {
    const testFiles = Array.from({ length: 3 }, (_, index) => `test/case-${index}.test.ts`);

    expect(
      partitionTestFiles(testFiles, FULL_RUN_TEST_BATCH_SIZE).map((batch) => batch.length),
    ).toEqual([1, 1, 1]);
  });

  test.each([
    "win32",
    "linux",
    "darwin",
  ] as const)("serializes tests within each isolated full-suite file on %s", (platform) => {
    const invocation = buildTestInvocation({
      platform,
      repoRoot,
      bunPath,
      args: [path.join(repoRoot, "test", "example.test.ts")],
      fullRunFile: true,
    });

    expect(invocation.command).toContain("--max-concurrency=1");
  });

  test.each([
    "win32",
    "linux",
    "darwin",
  ] as const)("writes a junit report for each full-suite file on %s", (platform) => {
    const junitOutfile = path.join(repoRoot, "report.junit.xml");
    const invocation = buildTestInvocation({
      platform,
      repoRoot,
      bunPath,
      args: [path.join(repoRoot, "test", "example.test.ts")],
      fullRunFile: true,
      junitOutfile,
    });

    expect(invocation.command).toContain("--reporter=junit");
    expect(invocation.command).toContain(`--reporter-outfile=${junitOutfile}`);
  });

  test("collects failing tests from a Bun junit report", () => {
    const report = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="4" failures="2" skipped="1">
  <testsuite name="sample.test.ts" file="sample.test.ts">
    <testsuite name="outer" file="sample.test.ts" line="3">
      <testcase name="passes" classname="outer" file="sample.test.ts" line="4" assertions="1" />
      <testcase name="fails one" classname="outer" file="sample.test.ts" line="5" assertions="1">
        <failure type="AssertionError" />
      </testcase>
      <testsuite name="inner" file="sample.test.ts" line="6">
        <testcase name="fails two" classname="inner &amp;gt; outer" file="sample.test.ts" line="7">
          <failure type="AssertionError" />
        </testcase>
        <testcase name="skipped" classname="inner &amp;gt; outer" file="sample.test.ts" line="8">
          <skipped />
        </testcase>
      </testsuite>
    </testsuite>
  </testsuite>
</testsuites>`;

    expect(parseJUnitFailures(report)).toEqual([
      { name: "fails one", classname: "outer" },
      { name: "fails two", classname: "inner > outer" },
    ]);
  });

  test("returns no failures for a passing junit report", () => {
    const report = `<testsuites><testsuite name="ok.test.ts">
      <testcase name="passes" classname="suite" />
    </testsuite></testsuites>`;

    expect(parseJUnitFailures(report)).toEqual([]);
  });

  test("summarizes every failing file and test at the bottom of a full run", () => {
    const summary = formatFailureSummary([
      {
        files: ["test/foo.test.ts"],
        exitCode: 1,
        failures: [
          { name: "fails one", classname: "outer" },
          { name: "fails two", classname: "outer > inner" },
        ],
      },
      { files: ["test/bar.test.ts"], exitCode: 134, failures: [] },
    ]);

    expect(summary).toBe(
      [
        "2 test files failed (2 failing tests):",
        "",
        "✗ test/foo.test.ts",
        "    outer > fails one",
        "    outer > inner > fails two",
        "✗ test/bar.test.ts",
        "    (exited with code 134 before reporting test results)",
      ].join("\n"),
    );
  });
});
