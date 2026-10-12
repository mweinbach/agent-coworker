import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import { buildWindowsRustCommandRunner } from "../scripts/windowsSandboxBundle";
import { scratchRoots } from "../src/platform/sandbox/policy";

const MSVC_VERSION = "14.44.35207";
const SDK_VERSION = "10.0.26100.0";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function scratchHome(): Promise<string> {
  const root = await fs.mkdtemp(path.join(scratchRoots()[0], "cowork-win-rust-"));
  roots.push(root);
  return root;
}

async function createToolchain(root: string): Promise<void> {
  const version = path.join(root, ".msvc", "VC", "Tools", "MSVC", MSVC_VERSION);
  const kits = path.join(root, ".msvc", "Windows Kits", "10");
  await Promise.all(
    [
      path.join(root, ".cargo", "bin"),
      path.join(version, "bin", "Hostarm64", "ARM64"),
      path.join(version, "bin", "Hostarm64", "x64"),
      path.join(version, "bin", "Hostx64", "ARM64"),
      path.join(version, "bin", "Hostx64", "x64"),
      path.join(root, ".msvc", "VC", "Tools", "Llvm", "ARM64", "bin"),
      path.join(root, ".msvc", "VC", "Tools", "Llvm", "x64", "bin"),
      path.join(kits, "bin", SDK_VERSION, "arm64"),
      path.join(kits, "bin", SDK_VERSION, "x64"),
      path.join(kits, "Lib", SDK_VERSION),
    ].map((dir) => fs.mkdir(dir, { recursive: true })),
  );
}

describe("Windows rust sandbox command runner", () => {
  test("leaves a non-Windows host on the original command", async () => {
    const root = await scratchHome();
    await createToolchain(root);
    const env = { COWORK_HOME_OVERRIDE: root, MARKER: "keep" };
    const options = { cwd: root, env };
    const calls: Array<{ command: string[]; env: NodeJS.ProcessEnv | undefined }> = [];
    const runner = buildWindowsRustCommandRunner(
      "aarch64-pc-windows-msvc",
      { platform: "linux", arch: "arm64" },
      async (command, received) => {
        calls.push({ command, env: received.env });
      },
    );

    await runner(["rustup", "target", "add", "aarch64-pc-windows-msvc"], options);

    expect(calls).toEqual([
      { command: ["rustup", "target", "add", "aarch64-pc-windows-msvc"], env },
    ]);
    expect(calls[0]?.env).toBe(env);
    expect(env).toEqual({ COWORK_HOME_OVERRIDE: root, MARKER: "keep" });
  });

  test("points an ARM64 host at native ARM64 tools", async () => {
    const root = await scratchHome();
    await createToolchain(root);
    const env = {
      COWORK_HOME_OVERRIDE: root,
      PATH: "C:\\Windows\\System32",
      LIB: "C:\\stale\\x64",
    };
    const calls: Array<{ command: string[]; env: NodeJS.ProcessEnv | undefined }> = [];
    const runner = buildWindowsRustCommandRunner(
      "aarch64-pc-windows-msvc",
      { platform: "win32", arch: "arm64" },
      async (command, received) => {
        calls.push({ command, env: received.env });
      },
    );

    await runner(["rustup", "target", "add", "aarch64-pc-windows-msvc"], { cwd: root, env });

    const msvcRoot = path.join(root, ".msvc");
    const version = path.join(msvcRoot, "VC", "Tools", "MSVC", MSVC_VERSION);
    const kits = path.join(msvcRoot, "Windows Kits", "10");
    const merged = calls[0]?.env;
    expect(calls[0]?.command).toEqual(["rustup", "target", "add", "aarch64-pc-windows-msvc"]);
    expect(merged?.PATH?.split(";")).toEqual([
      path.join(root, ".cargo", "bin"),
      path.join(msvcRoot, "VC", "Tools", "Llvm", "ARM64", "bin"),
      path.join(version, "bin", "Hostarm64", "ARM64"),
      path.join(kits, "bin", SDK_VERSION, "arm64"),
      "C:\\Windows\\System32",
    ]);
    expect(merged?.LIB).toBe(
      [
        path.join(version, "lib", "arm64"),
        path.join(kits, "Lib", SDK_VERSION, "ucrt", "arm64"),
        path.join(kits, "Lib", SDK_VERSION, "um", "arm64"),
      ].join(";"),
    );
    expect(merged?.VSCMD_ARG_TGT_ARCH).toBe("arm64");
    expect(merged?.VSINSTALLDIR).toBe(`${msvcRoot}\\`);
    expect(merged?.WindowsSdkVersion).toBe(`${SDK_VERSION}\\`);
    expect(env.LIB).toBe("C:\\stale\\x64");
    expect(env.VSINSTALLDIR).toBeUndefined();
  });

  test("uses x64 host tools for an x64 build and for an ARM64 cross build", async () => {
    const root = await scratchHome();
    await createToolchain(root);
    const msvcRoot = path.join(root, ".msvc");
    const version = path.join(msvcRoot, "VC", "Tools", "MSVC", MSVC_VERSION);
    const kits = path.join(msvcRoot, "Windows Kits", "10");
    const seen: Array<{ target: string; path: string | undefined; lib: string | undefined }> = [];
    for (const target of ["x86_64-pc-windows-msvc", "aarch64-pc-windows-msvc"] as const) {
      const runner = buildWindowsRustCommandRunner(
        target,
        { platform: "win32", arch: "x64" },
        async (_command, received) => {
          seen.push({
            target,
            path: received.env?.PATH,
            lib: received.env?.LIB,
          });
        },
      );
      await runner(["cargo", "build"], {
        cwd: root,
        env: { COWORK_HOME_OVERRIDE: root, PATH: "C:\\Windows" },
      });
    }

    const targetArch = ["x64", "arm64"] as const;
    for (const [index, arch] of targetArch.entries()) {
      expect(seen[index]?.path?.split(";")).toEqual([
        path.join(root, ".cargo", "bin"),
        path.join(msvcRoot, "VC", "Tools", "Llvm", "x64", "bin"),
        path.join(version, "bin", "Hostx64", arch === "arm64" ? "ARM64" : "x64"),
        path.join(kits, "bin", SDK_VERSION, "x64"),
        "C:\\Windows",
      ]);
      expect(seen[index]?.lib?.split(";")).toEqual([
        path.join(version, "lib", arch),
        path.join(kits, "Lib", SDK_VERSION, "ucrt", arch),
        path.join(kits, "Lib", SDK_VERSION, "um", arch),
      ]);
    }
  });

  test("preserves caller include paths and does not invent MSVC vars for a broken tree", async () => {
    const root = await scratchHome();
    await createToolchain(root);
    const calls: Array<NodeJS.ProcessEnv | undefined> = [];
    const runner = buildWindowsRustCommandRunner(
      "aarch64-pc-windows-msvc",
      { platform: "win32", arch: "arm64" },
      async (_command, received) => {
        calls.push(received.env);
      },
    );
    await runner(["cargo", "build"], {
      cwd: root,
      env: {
        COWORK_HOME_OVERRIDE: root,
        PATH: "C:\\Windows",
        INCLUDE: "C:\\custom\\include",
        VSINSTALLDIR: "C:\\BuildTools\\",
        LIB: "C:\\stale\\x64",
      },
    });
    expect(calls[0]?.INCLUDE).toBe("C:\\custom\\include");
    expect(calls[0]?.VSINSTALLDIR).toBe("C:\\BuildTools\\");
    expect(calls[0]?.LIB).not.toBe("C:\\stale\\x64");
    expect(calls[0]?.VCToolsInstallDir).toBe(
      `${path.join(root, ".msvc", "VC", "Tools", "MSVC", MSVC_VERSION)}\\`,
    );

    const broken = await scratchHome();
    const cargoBin = path.join(broken, ".cargo", "bin");
    await fs.mkdir(path.join(broken, ".msvc", "VC", "Tools"), { recursive: true });
    await fs.writeFile(path.join(broken, ".msvc", "VC", "Tools", "MSVC"), "not a directory");
    await fs.mkdir(cargoBin, { recursive: true });
    const caller = { COWORK_HOME_OVERRIDE: broken, PATH: "C:\\Windows", LIB: "unchanged" };
    const brokenCalls: Array<NodeJS.ProcessEnv | undefined> = [];
    const brokenRunner = buildWindowsRustCommandRunner(
      "aarch64-pc-windows-msvc",
      { platform: "win32", arch: "x64" },
      async (_command, received) => {
        brokenCalls.push(received.env);
      },
    );
    await brokenRunner(["rustup", "target", "add", "aarch64-pc-windows-msvc"], {
      cwd: broken,
      env: caller,
    });
    expect(brokenCalls[0]?.PATH?.split(";")).toEqual([cargoBin, "C:\\Windows"]);
    expect(brokenCalls[0]?.LIB).toBe("unchanged");
    expect(brokenCalls[0]?.VSINSTALLDIR).toBeUndefined();
    expect(caller).toEqual({
      COWORK_HOME_OVERRIDE: broken,
      PATH: "C:\\Windows",
      LIB: "unchanged",
    });
  });
});
