import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import { __libreOfficeInternal } from "../src/coworkRuntime";

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

  test("reports the managed launcher and its headless-only policy", async () => {
    const calls: string[] = [];
    const status = await __libreOfficeInternal.checkLibreOfficeCapabilityWithRunner(
      { candidates: ["/runtime/bin/soffice"] },
      async (command, args) => {
        calls.push(`${command} ${args.join(" ")}`);
        return { exitCode: 0, stdout: "LibreOffice 26.2.3.2\n", stderr: "" };
      },
    );

    expect(status).toMatchObject({
      status: "available",
      version: "26.2.3.2",
      resolvedPath: "/runtime/bin/soffice",
    });
    expect(status.message).toContain("UI and printing modes are blocked");
    expect(calls).toEqual(["/runtime/bin/soffice --version"]);
  });

  test("performs a real conversion-shaped smoke check through the managed launcher", async () => {
    let smokeArgs: string[] = [];
    const status = await __libreOfficeInternal.checkLibreOfficeCapabilityWithRunner(
      { candidates: ["/runtime/bin/soffice"], smoke: true },
      async (_command, args) => {
        if (args[0] === "--version") {
          return { exitCode: 0, stdout: "LibreOffice 26.2.3.2\n", stderr: "" };
        }
        smokeArgs = args;
        const outDir = args[args.indexOf("--outdir") + 1];
        await fs.writeFile(path.join(outDir, "cowork-soffice-smoke.pdf"), "%PDF-smoke\n");
        return { exitCode: 0, stdout: "convert ok\n", stderr: "" };
      },
    );

    expect(status.status).toBe("available");
    expect(status.smoke?.ok).toBe(true);
    expect(status.smoke?.sizeBytes).toBeGreaterThan(0);
    expect(smokeArgs).toContain("--convert-to");
    expect(smokeArgs).toContain("pdf");
  });
});
