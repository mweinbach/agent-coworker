import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import { __libreOfficeInternal } from "../src/coworkRuntime";
import type { SandboxTransformInput, SandboxTransformResult } from "../src/platform/sandbox";

const versionResult = { exitCode: 0, stdout: "LibreOffice 26.2.3.2\n", stderr: "" };
const smokeOptions = {
  env: { COWORK_RUNTIME_SOFFICE: "/runtime/bin/soffice" },
  smoke: true,
};

function enforced(input: SandboxTransformInput): SandboxTransformResult {
  return {
    file: "/sandbox-helper",
    args: ["--", input.file, ...input.args],
    env: { COWORK_SANDBOX: "test-backend", COWORK_SANDBOX_NETWORK_DISABLED: "1" },
    sandbox: "linux-bwrap",
    unsandboxed: false,
    enforcement: { filesystem: true, network: true, process: true, integrity: true },
  };
}

describe("managed headless LibreOffice capability", () => {
  test("only resolves the launcher exported by the active Cowork runtime", () => {
    expect(__libreOfficeInternal.candidateCommands({ PATH: "/usr/bin" })).toEqual([]);
    expect(
      __libreOfficeInternal.candidateCommands({
        COWORK_RUNTIME_SOFFICE: "/runtime/dependencies/bin/soffice",
      }),
    ).toEqual(["/runtime/dependencies/bin/soffice"]);
  });

  test("reports a broken or legacy runtime instead of falling back to host LibreOffice", async () => {
    const status = await __libreOfficeInternal.checkLibreOfficeCapabilityWithRunner(
      { env: { PATH: "/usr/bin" } },
      async () => {
        throw new Error("host soffice must not be probed");
      },
    );

    expect(status.status).toBe("unavailable");
    expect(status.message).toContain("active Cowork runtime");
    expect(status.resolvedPath).toBeUndefined();
    expect(status.smoke).toBeUndefined();
  });

  test("version-only availability does not claim conversion readiness or run a smoke probe", async () => {
    const calls: string[] = [];
    const status = await __libreOfficeInternal.checkLibreOfficeCapabilityWithRunner(
      { candidates: ["/runtime/bin/soffice"] },
      async (command, args) => {
        calls.push(`${command} ${args.join(" ")}`);
        return versionResult;
      },
      () => {
        throw new Error("version-only checks must not probe sandbox capabilities");
      },
    );

    expect(status).toMatchObject({
      status: "available",
      version: "26.2.3.2",
      resolvedPath: "/runtime/bin/soffice",
    });
    expect(status.message).toContain("UI and printing modes are blocked");
    expect(status.message).toContain("conversion readiness is unverified");
    expect(status.smoke).toBeUndefined();
    expect(calls).toEqual(["/runtime/bin/soffice --version"]);
  });

  test("runs conversion through an enforcing sandbox with isolated writable scratch", async () => {
    let smokeArgs: string[] = [];
    let scratch = "";
    let transforms = 0;
    const status = await __libreOfficeInternal.checkLibreOfficeCapabilityWithRunner(
      {
        ...smokeOptions,
        env: {
          ...smokeOptions.env,
          TMPDIR: "/outside-sandbox",
          Temp: "/outside-sandbox",
          tmp: "/outside-sandbox",
          COWORK_SANDBOX_NETWORK_DISABLED: "0",
        },
      },
      async (command, args, opts) => {
        if (args[0] === "--version") {
          expect(command).toBe("/runtime/bin/soffice");
          return versionResult;
        }
        expect(command).toBe("/sandbox-helper");
        expect(args.slice(0, 2)).toEqual(["--", "/runtime/bin/soffice"]);
        expect(opts.cwd).toBe(scratch);
        expect(opts.env).toMatchObject({
          TMPDIR: scratch,
          TEMP: scratch,
          TMP: scratch,
          COWORK_SANDBOX: "test-backend",
          COWORK_SANDBOX_NETWORK_DISABLED: "1",
        });
        expect(opts.env.Temp).toBeUndefined();
        expect(opts.env.tmp).toBeUndefined();
        smokeArgs = args;
        const outDir = args[args.indexOf("--outdir") + 1];
        expect(outDir).toBe(scratch);
        expect(await fs.readFile(args[args.length - 1], "utf8")).toContain("smoke test");
        await fs.writeFile(path.join(outDir, "cowork-soffice-smoke.pdf"), "%PDF-smoke\n");
        return { exitCode: 0, stdout: "convert ok\n", stderr: "" };
      },
      (input) => {
        transforms += 1;
        scratch = input.cwd;
        expect(input.file).toBe("/runtime/bin/soffice");
        expect(input.policy).toEqual({
          kind: "workspace-write",
          writableRoots: [scratch],
          network: false,
        });
        return enforced(input);
      },
    );

    expect(transforms).toBe(1);
    expect(status.status).toBe("available");
    expect(status.smoke?.ok).toBe(true);
    expect(status.smoke?.sizeBytes).toBeGreaterThan(0);
    expect(status.message).toContain("sandboxed conversion smoke test passed");
    expect(smokeArgs).toContain("--convert-to");
    expect(smokeArgs).toContain("pdf");
    expect(await fs.stat(scratch).catch(() => null)).toBeNull();
  });

  test.each(["unsandboxed", "none", "filesystem", "network", "process", "integrity"] as const)(
    "fails closed when sandbox enforcement is missing: %s",
    async (missing) => {
      let calls = 0;
      let scratch = "";
      const status = await __libreOfficeInternal.checkLibreOfficeCapabilityWithRunner(
        smokeOptions,
        async () => {
          calls += 1;
          return versionResult;
        },
        (input) => {
          scratch = input.cwd;
          const result = enforced(input);
          if (missing === "unsandboxed") result.unsandboxed = true;
          else if (missing === "none") result.sandbox = "none";
          else result.enforcement[missing] = false;
          result.warning = "test backend requires setup";
          return result;
        },
      );
      expect(calls).toBe(1);
      expect(status.status).toBe("unavailable");
      expect(status.smoke?.ok).toBe(false);
      expect(status.smoke?.error).toContain("Sandbox enforcement unavailable");
      expect(status.smoke?.error).toContain("test backend requires setup");
      expect(status.message).toBe(status.smoke?.error);
      expect(await fs.stat(scratch).catch(() => null)).toBeNull();
    },
  );

  test.each([
    { name: "missing PDF", exitCode: 0, pdf: undefined, detail: "non-empty PDF" },
    { name: "empty PDF", exitCode: 0, pdf: "", detail: "non-empty PDF" },
    { name: "failed conversion with PDF", exitCode: 134, pdf: "%PDF-partial", detail: "134" },
    { name: "signal termination with PDF", exitCode: null, pdf: "%PDF-partial", detail: "signal" },
  ])("rejects $name and explains the packaging boundary", async ({ exitCode, pdf, detail }) => {
    let scratch = "";
    const status = await __libreOfficeInternal.checkLibreOfficeCapabilityWithRunner(
      smokeOptions,
      async (_command, args) => {
        if (args[0] === "--version") return versionResult;
        scratch = args[args.indexOf("--outdir") + 1];
        if (pdf !== undefined) {
          await fs.writeFile(path.join(scratch, "cowork-soffice-smoke.pdf"), pdf);
        }
        return { exitCode, stdout: "", stderr: "controlled conversion diagnostic" };
      },
      enforced,
    );
    expect(status.status).toBe("unavailable");
    expect(status.version).toBe("26.2.3.2");
    expect(status.smoke?.ok).toBe(false);
    expect(status.smoke?.error).toContain(detail);
    expect(status.smoke?.error).toContain("controlled conversion diagnostic");
    expect(status.message).toContain("packaged for headless conversion");
    expect(status.message).toContain("Do not disable or loosen the sandbox");
    expect(await fs.stat(scratch).catch(() => null)).toBeNull();
  });

  test.each(["transform", "runner"])("reports %s exceptions and cleans scratch", async (stage) => {
    let scratch = "";
    let calls = 0;
    const status = await __libreOfficeInternal.checkLibreOfficeCapabilityWithRunner(
      smokeOptions,
      async (_command, args) => {
        calls += 1;
        if (args[0] === "--version") return versionResult;
        throw new Error("controlled runner failure");
      },
      (input) => {
        scratch = input.cwd;
        if (stage === "transform") throw new Error("controlled transform failure");
        return enforced(input);
      },
    );
    expect(calls).toBe(stage === "transform" ? 1 : 2);
    expect(status.status).toBe("unavailable");
    expect(status.smoke?.ok).toBe(false);
    expect(status.message).toContain(`controlled ${stage} failure`);
    expect(await fs.stat(scratch).catch(() => null)).toBeNull();
  });
});
