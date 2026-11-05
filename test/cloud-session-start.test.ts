import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import { scratchRoots } from "../scripts/scratchRoots";
import { which } from "../src/platform/exec";
import { hostPlatform } from "../src/platform/host";

const scriptPath = path.resolve(import.meta.dir, "../scripts/cloud_session_start.sh");
const fixtureRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    fixtureRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function writeExecutable(file: string, body: string) {
  await fs.writeFile(file, `#!/usr/bin/env bash\n${body}`, { mode: 0o755 });
}

/**
 * Builds a fixture repo with stub `bun`/`cargo`/`curl`/`sh` executables that log
 * their invocations. With `cargo: false` the PATH is restricted to the stubs plus
 * the few host tools the script needs, so a host Rust install cannot leak in.
 */
async function createFixture({ cargo = true }: { cargo?: boolean } = {}) {
  const root = await fs.mkdtemp(path.join(scratchRoots()[0], "cowork-cloud-session-"));
  fixtureRoots.push(root);
  const bin = path.join(root, "bin");
  const sysBin = path.join(root, "sysbin");
  const cargoHome = path.join(root, "cargo-home");
  const mobile = path.join(root, "apps/mobile");
  await fs.mkdir(bin);
  await fs.mkdir(sysBin);
  await fs.mkdir(mobile, { recursive: true });
  for (const directory of [root, mobile]) {
    await fs.writeFile(path.join(directory, "bun.lock"), "locked-dependencies\n");
    await fs.writeFile(path.join(directory, "package.json"), "{}\n");
  }
  await writeExecutable(
    path.join(bin, "bun"),
    'printf "%s|%s\\n" "$PWD" "$*" >> "$COWORK_TEST_INSTALL_LOG"\nmkdir -p node_modules\nexit "${COWORK_TEST_INSTALL_EXIT_CODE:-0}"\n',
  );
  if (cargo) {
    await writeExecutable(path.join(bin, "cargo"), "exit 0\n");
  }
  await writeExecutable(
    path.join(bin, "curl"),
    'printf "curl|%s\\n" "$*" >> "$COWORK_TEST_INSTALL_LOG"\necho "# rustup-init"\n',
  );
  await writeExecutable(
    path.join(bin, "sh"),
    [
      "cat >/dev/null",
      'printf "rustup-init|%s\\n" "$*" >> "$COWORK_TEST_INSTALL_LOG"',
      'mkdir -p "$CARGO_HOME/bin"',
      `printf '#!/usr/bin/env bash\\nprintf "rustup|%%s\\\\n" "$*" >> "$COWORK_TEST_INSTALL_LOG"\\n' > "$CARGO_HOME/bin/rustup"`,
      'chmod +x "$CARGO_HOME/bin/rustup"',
      "",
    ].join("\n"),
  );
  for (const tool of ["bash", "cat", "chmod", "mkdir", "sha256sum", "shasum"]) {
    const resolved = which(tool);
    if (resolved) await fs.symlink(resolved, path.join(sysBin, tool));
  }
  const log = path.join(root, "install.log");
  const basePath = cargo ? (process.env.PATH ?? "") : sysBin;
  return {
    root,
    mobile,
    async calls() {
      return (await this.allCalls()).filter((call) => call.includes("|install --frozen-lockfile"));
    },
    async allCalls() {
      return (await fs.readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean);
    },
    async run(overrides: NodeJS.ProcessEnv = {}) {
      const child = Bun.spawn(["bash", scriptPath], {
        cwd: root,
        env: {
          ...process.env,
          PATH: `${bin}${path.delimiter}${basePath}`,
          CARGO_HOME: cargoHome,
          // Keep host shell init (which may prepend ~/.cargo/bin) out of the fixture.
          BASH_ENV: "",
          HOME: root,
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
    const fixture = await createFixture({ cargo: false });
    await fixture.run({ CLAUDE_CODE_REMOTE: "false" });
    expect(await fixture.allCalls()).toEqual([]);
  });

  test("leaves an existing Rust toolchain alone", async () => {
    const fixture = await createFixture();
    await fixture.run();
    const calls = await fixture.allCalls();
    expect(calls.some((call) => call.startsWith("curl|"))).toBe(false);
    expect(calls.some((call) => call.startsWith("rustup"))).toBe(false);
  });

  test("bootstraps rustup and the pinned toolchain when cargo is missing", async () => {
    const fixture = await createFixture({ cargo: false });
    await fixture.run();
    const rustCalls = (await fixture.allCalls()).filter(
      (call) => !call.includes("|install --frozen-lockfile"),
    );
    expect(rustCalls).toEqual([
      "curl|--proto =https --tlsv1.2 -sSf https://sh.rustup.rs",
      "rustup-init|-s -- -y --profile minimal --default-toolchain none --no-modify-path",
      "rustup|toolchain install",
    ]);
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
