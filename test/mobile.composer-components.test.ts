import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

test("renders Android and iOS composer policies in an isolated component harness", async () => {
  const fixturePath = path.join(import.meta.dir, "fixtures", "mobile-composer-components.tsx");
  // Assert against the child's JUnit report, not reporter text: the default
  // reporter's per-test output changes across Bun versions.
  const junitDir = mkdtempSync(path.join(tmpdir(), "mobile-composer-junit-"));
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
    expect(report).toContain("android renders editable first-character policy");
    expect(report).toContain("ios renders editable first-character policy");
  } finally {
    rmSync(junitDir, { recursive: true, force: true });
  }
});
