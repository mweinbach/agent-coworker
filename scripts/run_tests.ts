import path from "node:path";

import { hostPlatform } from "../src/platform/host";

export type TestInvocation = {
  command: string[];
  cwd: string;
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
}): TestInvocation {
  const { platform, repoRoot, bunPath, args, fullRunFile = false } = options;
  const concurrencyArgs = fullRunFile ? ["--max-concurrency=1"] : [];
  if (platform !== "darwin") {
    return {
      command: [bunPath, "test", ...concurrencyArgs, ...args],
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
      "--isolate",
      "--preload",
      path.join(repoRoot, "test", "bun-test-bootstrap.ts"),
      ...testArgs,
    ],
    cwd: repoRoot,
  };
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
  const fullRun = args.length === 0;
  const argumentBatches = fullRun
    ? partitionTestFiles(await discoverProjectTestFiles(repoRoot), FULL_RUN_TEST_BATCH_SIZE)
    : [args];

  for (const batch of argumentBatches) {
    const exitCode = await runTestInvocation(
      buildTestInvocation({
        platform,
        repoRoot,
        bunPath: process.execPath,
        args: batch,
        fullRunFile: fullRun,
      }),
    );
    if (exitCode !== 0) process.exit(exitCode);
  }
}
