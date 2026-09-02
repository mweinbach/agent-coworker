import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { scratchRoots } from "../../../src/platform/sandbox/policy";
import { findInstalledElectronExecutable } from "../scripts/ensureElectronInstalled";
import { planDesktopBuild } from "../scripts/runDesktopBuild";

const desktopRoot = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);

function readInstalledPackageManifest(packageName: string): {
  version: string;
  peerDependencies?: Record<string, string>;
} {
  return JSON.parse(fs.readFileSync(require.resolve(`${packageName}/package.json`), "utf8"));
}

type BuildTrace = {
  stage: string;
  args: string[];
  platform: string;
  arch: string;
  marker: string;
};

async function traceDesktopBuild(
  args: readonly string[],
  targetEnvironment: NodeJS.ProcessEnv = {
    COWORK_BUILD_PLATFORM: "darwin",
    COWORK_BUILD_ARCH: "x64",
  },
  script = "build",
): Promise<{ exitCode: number; trace: BuildTrace[]; output: string }> {
  const root = fs.mkdtempSync(path.join(scratchRoots()[0], "cowork-desktop-build-"));
  const fixtureDesktop = path.join(root, "apps", "desktop");
  const tracePath = path.join(root, "build-trace.jsonl");
  try {
    fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
    fs.cpSync(path.join(desktopRoot, "scripts"), path.join(fixtureDesktop, "scripts"), {
      recursive: true,
    });
    fs.copyFileSync(
      path.resolve(desktopRoot, "../../scripts/releaseBuildUtils.ts"),
      path.join(root, "scripts", "releaseBuildUtils.ts"),
    );
    fs.writeFileSync(
      path.join(root, "scripts", "record.ts"),
      `import { appendFileSync } from "node:fs";
export function record(stage: string, args = process.argv.slice(2)) {
  appendFileSync(process.env.COWORK_BUILD_TRACE!, JSON.stringify({
    stage, args, platform: process.env.COWORK_BUILD_PLATFORM,
    arch: process.env.COWORK_BUILD_ARCH, marker: process.env.COWORK_TEST_MARKER,
  }) + "\\n");
}
if (import.meta.main) record(process.argv[2]!, process.argv.slice(3));
`,
    );
    fs.writeFileSync(
      path.join(fixtureDesktop, "scripts", "runElectronBuilder.ts"),
      'import { record } from "../../../scripts/record"; record("builder");\n',
    );
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        scripts: { "build:desktop-resources": "bun scripts/record.ts resources" },
      }),
    );
    const manifest = JSON.parse(fs.readFileSync(path.join(desktopRoot, "package.json"), "utf8"));
    fs.writeFileSync(
      path.join(fixtureDesktop, "package.json"),
      JSON.stringify({
        ...manifest,
        scripts: {
          build: manifest.scripts.build,
          "build:dir": manifest.scripts["build:dir"],
          "electron:ensure": "bun ../../scripts/record.ts ensure",
          "electron-vite": "bun ../../scripts/record.ts renderer",
        },
      }),
    );
    const child = Bun.spawn([process.execPath, "run", script, "--", ...args], {
      cwd: fixtureDesktop,
      env: {
        ...process.env,
        ...targetEnvironment,
        COWORK_BUILD_TRACE: tracePath,
        COWORK_TEST_MARKER: "preserve-parent-environment",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const trace = fs.existsSync(tracePath)
      ? fs
          .readFileSync(tracePath, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as BuildTrace)
      : [];
    return { exitCode, trace, output: `${stdout}${stderr}` };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe("Electron startup preflight", () => {
  test("uses an electron-vite release compatible with the installed Vite runtime", async () => {
    const electronVite = readInstalledPackageManifest("electron-vite");
    const vite = await import("vite");
    const vitePlus = await import("vite-plus");
    const supportedViteRange = electronVite.peerDependencies?.vite;

    expect(supportedViteRange).toBeDefined();
    expect(Bun.semver.satisfies(vite.version, supportedViteRange ?? "")).toBeTrue();
    expect(vite.version).toBe(vitePlus.version);
  });

  test("runs before electron-vite development and preview commands", () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(desktopRoot, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };

    expect(manifest.scripts["electron:ensure"]).toBe("bun scripts/ensureElectronInstalled.ts");
    expect(manifest.scripts.dev).toContain(
      "bun run electron:ensure && bun run electron-vite -- dev",
    );
    expect(manifest.scripts.preview).toContain(
      "bun run electron:ensure && bun run electron-vite -- preview",
    );
  });

  test("detects when Electron's executable is missing", () => {
    const moduleDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-electron-preflight-"));
    fs.writeFileSync(path.join(moduleDir, "path.txt"), "Electron.app/Contents/MacOS/Electron");

    try {
      expect(findInstalledElectronExecutable(moduleDir)).toBeNull();
    } finally {
      fs.rmSync(moduleDir, { force: true, recursive: true });
    }
  });

  test("returns Electron executable path when path.txt and binary are present", () => {
    const moduleDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-electron-preflight-"));
    const executablePath = path.join(moduleDir, "dist", "Electron.app", "Contents", "MacOS");
    fs.mkdirSync(executablePath, { recursive: true });
    fs.writeFileSync(path.join(executablePath, "Electron"), "");
    fs.writeFileSync(path.join(moduleDir, "path.txt"), "Electron.app/Contents/MacOS/Electron");

    try {
      expect(findInstalledElectronExecutable(moduleDir)).toBe(
        path.join(moduleDir, "dist", "Electron.app", "Contents", "MacOS", "Electron"),
      );
    } finally {
      fs.rmSync(moduleDir, { force: true, recursive: true });
    }
  });
});

describe("desktop package build target dispatch", () => {
  test("normalizes environment aliases without changing the caller environment", () => {
    const env = { COWORK_BUILD_PLATFORM: "windows", COWORK_BUILD_ARCH: "aarch64" };

    const plan = planDesktopBuild([], env);

    expect(plan.target).toEqual({ platform: "win32", arch: "arm64" });
    expect(plan.builderArgs).toEqual(["--win", "--arm64"]);
    expect(env).toEqual({ COWORK_BUILD_PLATFORM: "windows", COWORK_BUILD_ARCH: "aarch64" });
  });

  test("resolves architecture-qualified formats and platform aliases", () => {
    const plan = planDesktopBuild(["--windows", "nsis:arm64", "--publish", "never"], {
      COWORK_BUILD_ARCH: "x64",
    });

    expect(plan.target).toEqual({ platform: "win32", arch: "arm64" });
    expect(plan.builderArgs).toEqual(["--windows", "nsis:arm64", "--publish", "never", "--arm64"]);
  });

  test.each(["--arm64=false", "--no-arm64", "--arch=arm64"])(
    "rejects ambiguous or unsupported architecture selectors: %s",
    (argument) => {
      expect(() => planDesktopBuild([argument])).toThrow("Select");
    },
  );

  test("uses the requested target for resources, preflight, renderer, and packaging", async () => {
    const result = await traceDesktopBuild(["--win", "--arm64", "--publish", "never"]);

    expect(result.exitCode).toBe(0);
    expect(result.trace.map((entry) => entry.stage)).toEqual([
      "resources",
      "ensure",
      "renderer",
      "builder",
    ]);
    for (const entry of result.trace) {
      expect(entry.platform).toBe("win32");
      expect(entry.arch).toBe("arm64");
      expect(entry.marker).toBe("preserve-parent-environment");
    }
    expect(result.trace.at(-1)?.args).toEqual(["--win", "--arm64", "--publish", "never"]);
  });

  test("turns environment-only targets into matching Electron builder flags", async () => {
    const result = await traceDesktopBuild([], {
      COWORK_BUILD_PLATFORM: "win32",
      COWORK_BUILD_ARCH: "arm64",
    });

    expect(result.exitCode).toBe(0);
    expect(result.trace.at(-1)?.args).toEqual(["--win", "--arm64"]);
  });

  test("preserves unpacked builds and non-target builder options", async () => {
    const args = ["--linux", "--x64", "--config.compression=store", "--publish", "never"];
    const result = await traceDesktopBuild(args, {}, "build:dir");

    expect(result.exitCode).toBe(0);
    expect(result.trace.at(-1)?.args).toEqual(["--dir", ...args]);
    expect(result.trace.every((entry) => entry.platform === "linux" && entry.arch === "x64")).toBe(
      true,
    );
  });

  test.each([
    { args: ["--mac", "--win"] },
    { args: ["--x64", "--arm64"] },
    { args: ["--universal"] },
    { args: ["--win", "nsis:arm64", "portable:x64"] },
  ])(
    "rejects unsupported target combinations before starting build commands: %j",
    async ({ args }) => {
      const result = await traceDesktopBuild(args);

      expect(result.exitCode).not.toBe(0);
      expect(result.trace).toEqual([]);
    },
  );
});
