import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  __internal,
  checkManagedSofficeRuntime,
  ensureManagedSofficeRuntimeReady,
  prepareManagedSofficeToolEnv,
  renderManagedSofficeRuntimeInstructions,
} from "../src/managedSofficeRuntime";

function expectedShimName(): string {
  return process.platform === "win32" ? "soffice.cmd" : "soffice";
}

describe("managed soffice runtime", () => {
  test("creates a PATH-first soffice shim without touching skill files", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-soffice-home-"));
    const env = { PATH: "/usr/bin:/bin" };

    try {
      const result = await ensureManagedSofficeRuntimeReady({
        homedir: home,
        env,
        nodePath: "/usr/local/bin/node",
      });

      expect(result?.status).toBe("available");
      expect(result?.shimPath).toBe(
        path.join(home, ".cache", "cowork", "libreoffice", "bin", expectedShimName()),
      );
      expect(result?.helperPath).toBe(
        path.join(home, ".cache", "cowork", "libreoffice", "libexec", "managed-soffice.mjs"),
      );
      expect(result?.runtimeEnv.COWORK_SOFFICE).toBe(result?.shimPath);
      expect(result?.runtimeEnv.SAL_DISABLE_SYNCHRONOUS_PRINTER_DETECTION).toBe("1");
      expect(result?.runtimeEnv.COWORK_MANAGED_SOFFICE_ROOT).toBe(
        path.join(home, ".cache", "cowork", "libreoffice"),
      );
      expect(result?.runtimeEnv.PATH?.split(path.delimiter)[0]).toBe(result?.shimDir);

      const shim = await fs.readFile(result?.shimPath ?? "", "utf-8");
      const helper = await fs.readFile(result?.helperPath ?? "", "utf-8");
      expect(shim).toContain("/usr/local/bin/node");
      expect(shim).toContain("managed-soffice.mjs");
      expect(helper).toContain("download.documentfoundation.org/libreoffice/stable");
      expect(helper).toContain("COWORK_DISABLE_MANAGED_SOFFICE_DOWNLOAD");
      expect(helper).toContain("LibreOffice_${version}_Win_x86-64.msi");
      expect(helper).toContain("LibreOffice_${version}_Win_aarch64.msi");
      expect(helper).toContain(
        'run("msiexec.exe", ["/a", archivePath, "/qn", "TARGETDIR=" + stagedRoot]',
      );
      expect(helper).toContain("windowsHide: true");
      expect(helper).toContain('path.join(root, "program", "soffice.com")');
      expect(helper).toContain(
        'path.join(programFilesDir, "LibreOffice", "program", "soffice.com")',
      );
      expect(helper).toContain("pathToFileURL(profileDir).href");
      expect(helper).toContain("createNormalizedHeadlessArgs");
      expect(helper).toContain("argsWithoutProfiles");
      expect(helper).toContain("replaced caller LibreOffice profile");
      expect(helper).toContain("SAL_DISABLE_SYNCHRONOUS_PRINTER_DETECTION");
      expect(helper).toContain('oor:path="/org.openoffice.Office.Common/Save/Document"');
      expect(helper).toContain('oor:name="LoadPrinter"');
      expect(helper).toContain('"--nodefault"');
      expect(helper).toContain('"--nolockcheck"');
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  test("can be disabled through env", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-soffice-disabled-"));

    try {
      const result = await ensureManagedSofficeRuntimeReady({
        homedir: home,
        env: { COWORK_DISABLE_MANAGED_SOFFICE: "1" },
      });

      expect(result).toEqual({
        status: "disabled",
        runtimeEnv: {},
        reason: "COWORK_DISABLE_MANAGED_SOFFICE is enabled.",
      });
      await expect(
        fs.stat(path.join(home, ".cache", "cowork", "libreoffice", "bin", expectedShimName())),
      ).rejects.toThrow();
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  test("shim fails cleanly when download is disabled and no soffice is available", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-soffice-shim-"));

    try {
      const setup = await ensureManagedSofficeRuntimeReady({
        homedir: home,
        env: { PATH: "" },
        nodePath: process.execPath,
      });
      expect(setup?.shimPath).toBeTruthy();

      const proc = Bun.spawnSync({
        cmd: [setup?.shimPath ?? "", "--version"],
        env: {
          ...process.env,
          PATH: setup?.shimDir ?? "",
          COWORK_DISABLE_MANAGED_SOFFICE_DOWNLOAD: "1",
          COWORK_IGNORE_SYSTEM_SOFFICE: "1",
          COWORK_MANAGED_SOFFICE_ROOT: setup?.rootDir ?? "",
          COWORK_MANAGED_SOFFICE_SHIM_DIR: setup?.shimDir ?? "",
        },
        stdout: "pipe",
        stderr: "pipe",
      });

      expect(proc.exitCode).toBe(127);
      await expect(fs.stat(path.join(setup?.rootDir ?? "", "runtime"))).rejects.toThrow();
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  test("shim replaces caller profiles and injects quiet headless defaults for conversions", async () => {
    if (process.platform === "win32") return;

    const home = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-soffice-headless-"));
    const fakeBin = path.join(home, "fake-bin");
    const fakeSoffice = path.join(fakeBin, "soffice");
    const capturedArgsPath = path.join(home, "captured-args.txt");
    const capturedProfilePath = path.join(home, "captured-profile.xcu");
    await fs.mkdir(fakeBin, { recursive: true });
    await fs.writeFile(
      fakeSoffice,
      `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "LibreOffice 26.2.3.2 fake"
  exit 0
fi
profile_url=""
: > "$COWORK_CAPTURE_ARGS"
for arg in "$@"; do
  printf "%s\\n" "$arg" >> "$COWORK_CAPTURE_ARGS"
  case "$arg" in
    -env:UserInstallation=*) profile_url="\${arg#-env:UserInstallation=}" ;;
  esac
done
profile_path="\${profile_url#file://}"
if [ -n "$profile_path" ] && [ -f "$profile_path/user/registrymodifications.xcu" ]; then
  cp "$profile_path/user/registrymodifications.xcu" "$COWORK_CAPTURE_PROFILE"
else
  printf "missing:%s\\n" "$profile_path" > "$COWORK_CAPTURE_PROFILE"
fi
exit 0
`,
      { encoding: "utf-8", mode: 0o755 },
    );
    await fs.chmod(fakeSoffice, 0o755);

    try {
      const setup = await ensureManagedSofficeRuntimeReady({
        homedir: home,
        env: { PATH: fakeBin },
        nodePath: process.execPath,
      });
      expect(setup?.shimPath).toBeTruthy();

      const proc = Bun.spawnSync({
        cmd: [
          setup?.shimPath ?? "",
          "-env:UserInstallation=file:///caller-profile",
          "--convert-to",
          "pdf",
          "--outdir",
          home,
          path.join(home, "input.html"),
        ],
        env: {
          ...process.env,
          ...(setup?.runtimeEnv ?? {}),
          COWORK_CAPTURE_ARGS: capturedArgsPath,
          COWORK_CAPTURE_PROFILE: capturedProfilePath,
          COWORK_DISABLE_MANAGED_SOFFICE_DOWNLOAD: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      });

      expect(proc.exitCode).toBe(0);
      const capturedArgs = (await fs.readFile(capturedArgsPath, "utf-8"))
        .trim()
        .split(/\r?\n/)
        .filter(Boolean);
      const userInstallationArgs = capturedArgs.filter((arg) =>
        arg.startsWith("-env:UserInstallation="),
      );
      expect(userInstallationArgs).toHaveLength(1);
      expect(userInstallationArgs[0]).toStartWith("-env:UserInstallation=file://");
      expect(userInstallationArgs[0]).not.toBe("-env:UserInstallation=file:///caller-profile");
      expect(capturedArgs).toContain("--headless");
      expect(capturedArgs).toContain("--invisible");
      expect(capturedArgs).toContain("--nologo");
      expect(capturedArgs).toContain("--nodefault");
      expect(capturedArgs).toContain("--nofirststartwizard");
      expect(capturedArgs).toContain("--nolockcheck");
      expect(capturedArgs).toContain("--norestore");
      expect(capturedArgs).toContain("--convert-to");
      expect(capturedArgs).toContain("pdf");
      const profileRegistry = await fs.readFile(capturedProfilePath, "utf-8");
      expect(profileRegistry).toContain('oor:name="LoadPrinter"');
      expect(profileRegistry).toContain("<value>false</value>");
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  test("diagnostic verifies availability when conversion produces a PDF through the shim", async () => {
    if (process.platform === "win32") return;

    const home = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-soffice-diagnostic-"));
    const fakeBin = path.join(home, "fake-bin");
    const fakeSoffice = path.join(fakeBin, "soffice");
    await fs.mkdir(fakeBin, { recursive: true });
    await fs.writeFile(
      fakeSoffice,
      `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "LibreOffice 26.2.3.2 fake"
  echo "LibreOffice 26.2.3.2 fake" >&2
  exit 0
fi
outdir=""
last=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--outdir" ]; then
    shift
    outdir="$1"
  fi
  last="$1"
  shift
done
base="\${last##*/}"
base="\${base%.html}"
printf "%s\\n" "%PDF-1.4 fake" > "$outdir/$base.pdf"
exit 7
`,
      { encoding: "utf-8", mode: 0o755 },
    );
    await fs.chmod(fakeSoffice, 0o755);

    try {
      const status = await checkManagedSofficeRuntime({
        homedir: home,
        env: { PATH: fakeBin },
        nodePath: process.execPath,
        smoke: true,
      });

      expect(status.status).toBe("available");
      expect(status.shimPath).toContain(
        path.join(".cache", "cowork", "libreoffice", "bin", expectedShimName()),
      );
      expect(status.smoke?.ok).toBe(true);
      expect(status.smoke?.sizeBytes).toBeGreaterThan(0);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  test("diagnostic reports unavailable when smoke conversion does not produce a PDF", async () => {
    if (process.platform === "win32") return;

    const home = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-soffice-smoke-failure-"));
    const fakeBin = path.join(home, "fake-bin");
    const fakeSoffice = path.join(fakeBin, "soffice");
    await fs.mkdir(fakeBin, { recursive: true });
    await fs.writeFile(
      fakeSoffice,
      `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "LibreOffice 26.2.3.2 fake"
  exit 0
fi
exit 0
`,
      { encoding: "utf-8", mode: 0o755 },
    );
    await fs.chmod(fakeSoffice, 0o755);

    try {
      const status = await checkManagedSofficeRuntime({
        homedir: home,
        env: { PATH: fakeBin },
        nodePath: process.execPath,
        smoke: true,
      });

      expect(status.status).toBe("unavailable");
      expect(status.smoke?.ok).toBe(false);
      expect(status.smoke?.error).toBeTruthy();
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  test("parses LibreOffice version output", () => {
    expect(__internal.parseSofficeVersion("LibreOffice 26.2.3.2 fake")).toBe("26.2.3.2");
  });

  test("renders platform-aware PATH instructions", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-soffice-instructions-"));

    try {
      const setup = await ensureManagedSofficeRuntimeReady({
        homedir: home,
        env: { PATH: "/usr/bin" },
      });
      const instructions = renderManagedSofficeRuntimeInstructions(setup?.runtimeEnv);

      expect(instructions).toContain("Managed LibreOffice Runtime");
      expect(instructions).toContain("SAL_DISABLE_SYNCHRONOUS_PRINTER_DETECTION=1");
      if (process.platform === "win32") {
        expect(instructions).toContain("$env:PATH = '");
        expect(instructions).toContain(";' + $env:PATH");
      } else {
        expect(instructions).toContain("PATH=");
        expect(instructions).toContain(":$PATH");
      }
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  test("adds printer detection guard even when soffice env is already prepared", async () => {
    const env = await prepareManagedSofficeToolEnv({
      env: {
        COWORK_SOFFICE: "/already/prepared/soffice",
        PATH: "/usr/bin",
      },
    });

    expect(env.COWORK_SOFFICE).toBe("/already/prepared/soffice");
    expect(env.SAL_DISABLE_SYNCHRONOUS_PRINTER_DETECTION).toBe("1");
  });
});
