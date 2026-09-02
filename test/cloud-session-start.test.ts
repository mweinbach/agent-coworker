import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import { hostPlatform } from "../src/platform/host";
import { scratchRoots } from "../src/platform/sandbox/policy";

const scriptPath = path.resolve(import.meta.dir, "../scripts/cloud_session_start.sh");
const fixtureRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    fixtureRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function createFixture() {
  const root = await fs.mkdtemp(path.join(scratchRoots()[0], "cowork-cloud-session-"));
  fixtureRoots.push(root);
  const bin = path.join(root, "bin");
  const mobile = path.join(root, "apps/mobile");
  await fs.mkdir(bin);
  await fs.mkdir(mobile, { recursive: true });
  for (const directory of [root, mobile]) {
    await fs.writeFile(path.join(directory, "bun.lock"), "locked-dependencies\n");
    await fs.writeFile(path.join(directory, "package.json"), "{}\n");
  }
  await fs.writeFile(
    path.join(bin, "bun"),
    '#!/usr/bin/env bash\nprintf "%s|%s\\n" "$PWD" "$*" >> "$COWORK_TEST_INSTALL_LOG"\nmkdir -p node_modules\nexit "${COWORK_TEST_INSTALL_EXIT_CODE:-0}"\n',
    { mode: 0o755 },
  );
  const log = path.join(root, "install.log");
  return {
    root,
    mobile,
    async calls() {
      return (await fs.readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean);
    },
    async run(overrides: NodeJS.ProcessEnv = {}) {
      const child = Bun.spawn(["bash", scriptPath], {
        cwd: root,
        env: {
          ...process.env,
          PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
          CLAUDE_CODE_REMOTE: "true",
          CLAUDE_PROJECT_DIR: root,
          COWORK_TEST_INSTALL_LOG: log,
          ...overrides,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
    },
  };
}

describe.skipIf(hostPlatform() === "win32")("cloud session dependency bootstrap", () => {
  test("does not install dependencies for local sessions", async () => {
    const fixture = await createFixture();
    await fixture.run({ CLAUDE_CODE_REMOTE: "false" });
    expect(await fixture.calls()).toEqual([]);
  });

  test("installs both locked dependency roots before caching either", async () => {
    const fixture = await createFixture();
    await fixture.run();
    expect(await fixture.calls()).toEqual([
      `${fixture.root}|install --frozen-lockfile`,
      `${fixture.mobile}|install --frozen-lockfile`,
    ]);

    await fixture.run();
    expect(await fixture.calls()).toHaveLength(2);
  });

  test("invalidates mobile dependencies independently when their lockfile changes", async () => {
    const fixture = await createFixture();
    await fixture.run();
    await fs.writeFile(path.join(fixture.mobile, "bun.lock"), "new-mobile-dependencies\n");
    await fixture.run();

    expect(await fixture.calls()).toEqual([
      `${fixture.root}|install --frozen-lockfile`,
      `${fixture.mobile}|install --frozen-lockfile`,
      `${fixture.mobile}|install --frozen-lockfile`,
    ]);
  });

  test("retries frozen installs without accepting or stamping failed dependency state", async () => {
    const fixture = await createFixture();
    await fixture.run({ COWORK_TEST_INSTALL_EXIT_CODE: "1" });
    const calls = await fixture.calls();
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.every((call) => call.endsWith("|install --frozen-lockfile"))).toBe(true);
    for (const directory of [fixture.root, fixture.mobile]) {
      expect(
        await Bun.file(path.join(directory, "node_modules/.cloud-install-stamp")).exists(),
      ).toBe(false);
    }
  });
});
