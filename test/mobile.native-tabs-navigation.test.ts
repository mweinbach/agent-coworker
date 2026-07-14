import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { scratchRoots } from "../src/platform/sandbox";

type Platform = "ios" | "android";

async function runPlatformContract(platform: Platform): Promise<string> {
  const fixturePath = path.join(import.meta.dir, "fixtures", "mobile-platform-contract.tsx");
  // Assert against the child's JUnit report, not reporter text: the default
  // reporter's per-test output changes across Bun versions.
  const junitDir = mkdtempSync(
    path.join(scratchRoots()[0] ?? "/tmp", `mobile-tabs-junit-${platform}-`),
  );
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
      env: {
        ...process.env,
        EXPO_OS: platform,
      },
      stderr: "pipe",
      stdout: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
    return readFileSync(junitPath, "utf8");
  } finally {
    rmSync(junitDir, { recursive: true, force: true });
  }
}

test("renders the native router and accessibility contract on iOS and Android", async () => {
  const [iosReport, androidReport] = await Promise.all([
    runPlatformContract("ios"),
    runPlatformContract("android"),
  ]);

  for (const [platform, report] of [
    ["ios", iosReport],
    ["android", androidReport],
  ] as const) {
    expect(report).toContain(`${platform} rendered mobile navigation and accessibility contract`);
    expect(report).toContain(
      "renders native tabs, independent stacks, deep links, history back, and pending badge",
    );
    expect(report).toContain(
      "matches the deterministic 200% accessibility tree and control behavior artifact",
    );
  }
});
