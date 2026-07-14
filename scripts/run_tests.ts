import { readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { hostPlatform } from "../src/platform/host";

export type TestInvocation = {
  command: string[];
  cwd: string;
};

export type TestFailure = {
  name: string;
  classname?: string;
};

export type FailedTestFile = {
  files: string[];
  exitCode: number;
  failures: TestFailure[];
};

export const FULL_RUN_TEST_BATCH_SIZE = 1;

export function partitionTestFiles(testFiles: string[], batchSize: number): string[][] {
  const batches: string[][] = [];
  for (let index = 0; index < testFiles.length; index += batchSize) {
    batches.push(testFiles.slice(index, index + batchSize));
  }
  return batches;
}

export function buildTestInvocation(options: {
  platform: NodeJS.Platform;
  repoRoot: string;
  bunPath: string;
  args: string[];
  fullRunFile?: boolean;
  junitOutfile?: string;
}): TestInvocation {
  const { platform, repoRoot, bunPath, args, fullRunFile = false, junitOutfile } = options;
  const concurrencyArgs = fullRunFile ? ["--max-concurrency=1"] : [];
  const reporterArgs = junitOutfile
    ? ["--reporter=junit", `--reporter-outfile=${junitOutfile}`]
    : [];
  if (platform !== "darwin") {
    return {
      command: [bunPath, "test", ...concurrencyArgs, ...reporterArgs, ...args],
      cwd: repoRoot,
    };
  }

  const testArgs =
    args.length > 0
      ? args.map((arg) =>
          arg.startsWith("test/") || arg.startsWith("apps/") ? path.join(repoRoot, arg) : arg,
        )
      : [path.join(repoRoot, "test"), path.join(repoRoot, "apps", "desktop", "test")];

  return {
    command: [
      bunPath,
      "test",
      ...concurrencyArgs,
      ...reporterArgs,
      "--isolate",
      "--preload",
      path.join(repoRoot, "test", "bun-test-bootstrap.ts"),
      ...testArgs,
    ],
    cwd: repoRoot,
  };
}

function decodeXmlEntities(value: string): string {
  // Unescape &amp; first: Bun's junit reporter double-escapes nested describe
  // names (classname="inner &amp;gt; outer"), so this order yields the
  // intended text for both single- and double-escaped attributes.
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&(?:apos|#39);/g, "'");
}

export function parseJUnitFailures(report: string): TestFailure[] {
  const failures: TestFailure[] = [];
  const testcasePattern = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g;
  for (const match of report.matchAll(testcasePattern)) {
    const body = match[2];
    if (!body || !/<(?:failure|error)\b/.test(body)) continue;
    const attrs = match[1] ?? "";
    const name = decodeXmlEntities(/\bname="([^"]*)"/.exec(attrs)?.[1] ?? "(unknown test)");
    const classname = decodeXmlEntities(/\bclassname="([^"]*)"/.exec(attrs)?.[1] ?? "");
    failures.push(classname ? { name, classname } : { name });
  }
  return failures;
}

export function formatFailureSummary(failedFiles: FailedTestFile[]): string {
  const failingTests = failedFiles.reduce((total, failed) => total + failed.failures.length, 0);
  const fileCount = failedFiles.length === 1 ? "1 test file" : `${failedFiles.length} test files`;
  const testCount = failingTests === 1 ? "1 failing test" : `${failingTests} failing tests`;
  const lines = [`${fileCount} failed${failingTests > 0 ? ` (${testCount})` : ""}:`, ""];
  for (const failed of failedFiles) {
    lines.push(`✗ ${failed.files.join(", ")}`);
    for (const failure of failed.failures) {
      lines.push(`    ${failure.classname ? `${failure.classname} > ` : ""}${failure.name}`);
    }
    if (failed.failures.length === 0) {
      lines.push(`    (exited with code ${failed.exitCode} before reporting test results)`);
    }
  }
  return lines.join("\n");
}

async function discoverProjectTestFiles(repoRoot: string): Promise<string[]> {
  const testRoots = [path.join(repoRoot, "test"), path.join(repoRoot, "apps", "desktop", "test")];
  const files: string[] = [];
  for (const testRoot of testRoots) {
    const glob = new Bun.Glob("**/*.test.{ts,tsx,js,jsx}");
    for await (const file of glob.scan({ cwd: testRoot, absolute: true })) {
      files.push(file);
    }
  }
  return files.sort();
}

async function runTestInvocation(invocation: TestInvocation): Promise<number> {
  const child = Bun.spawn(invocation.command, {
    cwd: invocation.cwd,
    env: process.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return child.exited;
}

if (import.meta.main) {
  const repoRoot = path.resolve(import.meta.dir, "..");
  const platform = hostPlatform();
  const args = process.argv.slice(2);

  if (args.length > 0) {
    const exitCode = await runTestInvocation(
      buildTestInvocation({ platform, repoRoot, bunPath: process.execPath, args }),
    );
    process.exit(exitCode);
  }

  const batches = partitionTestFiles(
    await discoverProjectTestFiles(repoRoot),
    FULL_RUN_TEST_BATCH_SIZE,
  );
  const junitOutfile = path.join(os.tmpdir(), `agent-coworker-tests-${process.pid}.junit.xml`);
  const failedFiles: FailedTestFile[] = [];

  for (const batch of batches) {
    rmSync(junitOutfile, { force: true });
    const exitCode = await runTestInvocation(
      buildTestInvocation({
        platform,
        repoRoot,
        bunPath: process.execPath,
        args: batch,
        fullRunFile: true,
        junitOutfile,
      }),
    );
    if (exitCode === 0) continue;
    let report = "";
    try {
      report = readFileSync(junitOutfile, "utf8");
    } catch {
      // The child can die before writing a report; the summary then falls
      // back to the exit code.
    }
    failedFiles.push({
      files: batch.map((file) => path.relative(repoRoot, file)),
      exitCode,
      failures: parseJUnitFailures(report),
    });
  }
  rmSync(junitOutfile, { force: true });

  if (failedFiles.length > 0) {
    console.error(`\n${formatFailureSummary(failedFiles)}`);
    process.exit(1);
  }
  console.error(`\nAll ${batches.length} test files passed.`);
}
