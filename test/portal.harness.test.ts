import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getHarnessRunDetail } from "../apps/portal/lib/harness";

const originalHarnessRepoRoot = process.env.HARNESS_REPO_ROOT;

let tempRepoRoot: string | null = null;

async function createHarnessRunFixture(): Promise<{
  runDirPath: string;
  runDirName: string;
  runRootName: string;
}> {
  tempRepoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "portal-harness-test-"));
  await fs.writeFile(path.join(tempRepoRoot, "package.json"), JSON.stringify({ name: "fixture" }), "utf-8");

  const runRootName = "raw-agent-loop_mixed_2026-02-11T00-00-00Z";
  const runDirName = "run_001";
  const runDirPath = path.join(tempRepoRoot, "output", runRootName, runDirName);

  await fs.mkdir(runDirPath, { recursive: true });
  await fs.writeFile(path.join(runDirPath, "run_meta.json"), JSON.stringify({ runId: "run_001" }), "utf-8");
  await fs.writeFile(path.join(runDirPath, "trace.json"), JSON.stringify({}), "utf-8");

  process.env.HARNESS_REPO_ROOT = tempRepoRoot;

  return { runDirPath, runDirName, runRootName };
}

afterEach(async () => {
  process.env.HARNESS_REPO_ROOT = originalHarnessRepoRoot;
  if (tempRepoRoot) {
    await fs.rm(tempRepoRoot, { recursive: true, force: true });
    tempRepoRoot = null;
  }
});

describe("portal harness detail", () => {
  test("getHarnessRunDetail returns empty files list when run directory disappears during readdir", async () => {
    const { runDirPath, runDirName, runRootName } = await createHarnessRunFixture();
    const fsWithMutableReaddir = fs as unknown as { readdir: (...args: unknown[]) => Promise<unknown> };
    const originalReaddir = fs.readdir.bind(fs) as (...args: unknown[]) => Promise<unknown>;

    fsWithMutableReaddir.readdir = async (...args: unknown[]) => {
      const [target] = args;
      if (typeof target === "string" && path.resolve(target) === runDirPath) {
        const err = new Error("run dir disappeared");
        (err as NodeJS.ErrnoException).code = "ENOENT";
        throw err;
      }
      return await originalReaddir(...args);
    };

    try {
      const detail = await getHarnessRunDetail(runRootName, runDirName);
      expect(detail).not.toBeNull();
      expect(detail?.files).toEqual([]);
    } finally {
      fsWithMutableReaddir.readdir = originalReaddir;
    }
  });
});
