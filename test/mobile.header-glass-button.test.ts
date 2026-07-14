import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { scratchRoots } from "../src/platform/sandbox";

test("renders mobile hub headers and grouped lists in an isolated component harness", async () => {
  const fixturePath = path.join(import.meta.dir, "fixtures", "mobile-header-glass-button.tsx");
  // Assert against the child's JUnit report, not reporter text: the default
  // reporter's per-test output changes across Bun versions.
  const junitDir = mkdtempSync(path.join(scratchRoots()[0] ?? "/tmp", "mobile-header-junit-"));
  const junitPath = path.join(junitDir, "results.xml");
  try {
    const child = Bun.spawn({
      cmd: [
        process.execPath,
        "test",
        "--reporter=junit",
        `--reporter-outfile=${junitPath}`,
        fixturePath,
      ],
      cwd: path.resolve(import.meta.dir, ".."),
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
    const report = readFileSync(junitPath, "utf8");
    expect(report).toContain("workspace hub renders a grouped native list");
    expect(report).toContain("settings hub renders a grouped native list");
    expect(report).toContain("hub stacks omit prominent header items and pairing empties them");
  } finally {
    rmSync(junitDir, { recursive: true, force: true });
  }
});
