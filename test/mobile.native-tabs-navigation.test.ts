import { expect, test } from "bun:test";
import path from "node:path";

type Platform = "ios" | "android";

async function runPlatformContract(platform: Platform): Promise<string> {
  const fixturePath = path.join(import.meta.dir, "fixtures", "mobile-platform-contract.tsx");
  const child = Bun.spawn({
    cmd: [process.execPath, "test", fixturePath],
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
  const output = `${stdout}\n${stderr}`;
  expect(exitCode, output).toBe(0);
  return output;
}

test("renders the native router and accessibility contract on iOS and Android", async () => {
  const [iosOutput, androidOutput] = await Promise.all([
    runPlatformContract("ios"),
    runPlatformContract("android"),
  ]);

  for (const [platform, output] of [
    ["ios", iosOutput],
    ["android", androidOutput],
  ] as const) {
    expect(output).toContain(`${platform} rendered mobile navigation and accessibility contract`);
    expect(output).toContain(
      "renders native tabs, independent stacks, deep links, history back, and pending badge",
    );
    expect(output).toContain(
      "matches the deterministic 200% accessibility tree and control behavior artifact",
    );
  }
});
