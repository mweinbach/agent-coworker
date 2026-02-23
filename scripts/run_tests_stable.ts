import { spawn } from "node:child_process";
import fg from "fast-glob";

const DEFAULT_BATCH_SIZE = 1;
const TEST_FILE_PATTERNS = ["test/**/*.test.ts", "apps/**/test/**/*.test.ts"];

function printUsageAndExit(): never {
  console.error("Usage: bun scripts/run_tests_stable.ts [--batch-size N] [-- <bun test args>]");
  process.exit(1);
}

function parseCli(argv: string[]): { batchSize: number; bunTestArgs: string[] } {
  let batchSize = Number(process.env.TEST_BATCH_SIZE ?? DEFAULT_BATCH_SIZE);
  const bunTestArgs: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") {
      bunTestArgs.push(...argv.slice(i + 1));
      break;
    }
    if (arg === "--batch-size") {
      const next = argv[i + 1];
      if (!next) printUsageAndExit();
      const parsed = Number.parseInt(next, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) printUsageAndExit();
      batchSize = parsed;
      i++;
      continue;
    }
    if (arg.startsWith("--batch-size=")) {
      const parsed = Number.parseInt(arg.slice("--batch-size=".length), 10);
      if (!Number.isFinite(parsed) || parsed <= 0) printUsageAndExit();
      batchSize = parsed;
      continue;
    }
    bunTestArgs.push(arg);
  }

  if (!Number.isFinite(batchSize) || batchSize <= 0) printUsageAndExit();
  return { batchSize, bunTestArgs };
}

async function runBun(args: string[]): Promise<number> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

async function main() {
  const startedAt = Date.now();
  const { batchSize, bunTestArgs } = parseCli(process.argv.slice(2));
  const testFiles = (
    await fg(TEST_FILE_PATTERNS, {
      cwd: process.cwd(),
      onlyFiles: true,
      unique: true,
      followSymbolicLinks: false,
    })
  ).sort((a, b) => a.localeCompare(b));

  if (testFiles.length === 0) {
    console.error("[test:stable] No test files were found.");
    process.exit(1);
  }

  const totalBatches = Math.ceil(testFiles.length / batchSize);
  console.log(
    `[test:stable] Running ${testFiles.length} files in ${totalBatches} batches (batch size ${batchSize}).`,
  );
  if (bunTestArgs.length > 0) {
    console.log(`[test:stable] Extra bun test args: ${bunTestArgs.join(" ")}`);
  }

  for (let i = 0; i < totalBatches; i++) {
    const batch = testFiles.slice(i * batchSize, (i + 1) * batchSize);
    const batchLabel = `${i + 1}/${totalBatches}`;
    console.log(`\n[test:stable] Batch ${batchLabel}: ${batch.length} file(s)`);

    const exitCode = await runBun(["test", ...bunTestArgs, ...batch]);
    if (exitCode !== 0) {
      console.error(`[test:stable] Batch ${batchLabel} failed with exit code ${exitCode}.`);
      process.exit(exitCode);
    }
  }

  const elapsedMs = Date.now() - startedAt;
  console.log(`\n[test:stable] Completed all batches in ${(elapsedMs / 1000).toFixed(1)}s.`);
}

await main();
