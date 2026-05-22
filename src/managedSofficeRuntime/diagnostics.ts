import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ensureManagedSofficeRuntimeReady } from "./ensureReady";
import { parseResolvedSofficePath, parseSofficeVersion } from "./paths";
import { processErrorMessage, runProcessCapture } from "./processCapture";
import type {
  EnsureManagedSofficeRuntimeOptions,
  ManagedSofficeRuntimeDiagnostic,
  ProcessCapture,
} from "./types";

export async function checkManagedSofficeRuntime(
  opts: EnsureManagedSofficeRuntimeOptions & { smoke?: boolean } = {},
): Promise<ManagedSofficeRuntimeDiagnostic> {
  const checkedAt = new Date().toISOString();
  const setup = await ensureManagedSofficeRuntimeReady(opts);
  if (!setup) {
    return {
      status: "unavailable",
      checkedAt,
      message: "Managed LibreOffice setup did not return a runtime.",
    };
  }
  if (setup.status === "disabled") {
    return {
      status: "disabled",
      checkedAt,
      message: setup.reason ?? "Managed LibreOffice runtime is disabled.",
    };
  }
  if (!setup.shimPath) {
    return {
      status: "unavailable",
      checkedAt,
      message: "Managed LibreOffice setup did not create a soffice shim.",
      rootDir: setup.rootDir,
    };
  }

  const baseEnv = opts.env ?? process.env;
  const runtimeEnv = {
    ...baseEnv,
    ...setup.runtimeEnv,
    COWORK_MANAGED_SOFFICE_VERBOSE: "1",
  };

  let resolvedPath: string | undefined;
  const resolveResult = await runProcessCapture(setup.shimPath, [], {
    env: { ...runtimeEnv, COWORK_MANAGED_SOFFICE_PRINT_REAL: "1" },
    timeoutMs: 180_000,
  }).catch((error) => ({ error }));
  if ("error" in resolveResult) {
    return {
      status: "unavailable",
      checkedAt,
      message:
        resolveResult.error instanceof Error
          ? resolveResult.error.message
          : String(resolveResult.error),
      shimPath: setup.shimPath,
      rootDir: setup.rootDir,
    };
  }
  if (resolveResult.exitCode === 0) {
    resolvedPath = resolveResult.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  }

  let versionResult: ProcessCapture;
  try {
    versionResult = await runProcessCapture(resolvedPath ?? setup.shimPath, ["--version"], {
      env: runtimeEnv,
      timeoutMs: 180_000,
    });
  } catch (error) {
    return {
      status: "unavailable",
      checkedAt,
      message: error instanceof Error ? error.message : String(error),
      shimPath: setup.shimPath,
      rootDir: setup.rootDir,
    };
  }

  if (versionResult.exitCode !== 0) {
    return {
      status: "unavailable",
      checkedAt,
      message:
        processErrorMessage(versionResult) ||
        `soffice --version failed with exit ${versionResult.exitCode ?? "unknown"}.`,
      shimPath: setup.shimPath,
      resolvedPath: resolvedPath ?? parseResolvedSofficePath(versionResult.stderr),
      rootDir: setup.rootDir,
    };
  }

  resolvedPath ??= parseResolvedSofficePath(versionResult.stderr);
  let version = parseSofficeVersion([versionResult.stdout, versionResult.stderr].join("\n"));
  if (!version && resolvedPath) {
    const directVersion = await runProcessCapture(resolvedPath, ["--version"], {
      env: runtimeEnv,
      timeoutMs: 30_000,
    }).catch(() => null);
    if (directVersion?.exitCode === 0) {
      version = parseSofficeVersion([directVersion.stdout, directVersion.stderr].join("\n"));
    }
  }
  let smoke: ManagedSofficeRuntimeDiagnostic["smoke"];
  if (opts.smoke === true) {
    const smokeStart = Date.now();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-soffice-smoke-"));
    const inputPath = path.join(tempDir, "cowork-soffice-smoke.html");
    const outputPath = path.join(tempDir, "cowork-soffice-smoke.pdf");
    try {
      await fs.writeFile(
        inputPath,
        "<!doctype html><title>Cowork LibreOffice Smoke</title><p>Cowork LibreOffice smoke test.</p>\n",
      );
      const smokeResult = await runProcessCapture(
        setup.shimPath,
        [
          "--headless",
          "--nologo",
          "--nofirststartwizard",
          "--convert-to",
          "pdf",
          "--outdir",
          tempDir,
          inputPath,
        ],
        {
          env: runtimeEnv,
          timeoutMs: 180_000,
        },
      );
      const stat = await fs.stat(outputPath).catch(() => null);
      if (smokeResult.exitCode === 0 && stat && stat.size > 0) {
        smoke = {
          ok: true,
          durationMs: Date.now() - smokeStart,
          outputPath,
          sizeBytes: stat.size,
        };
      } else {
        smoke = {
          ok: false,
          durationMs: Date.now() - smokeStart,
          error:
            processErrorMessage(smokeResult) ||
            `LibreOffice PDF conversion did not produce ${outputPath}.`,
        };
      }
    } catch (error) {
      smoke = {
        ok: false,
        durationMs: Date.now() - smokeStart,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  const failedSmoke = smoke?.ok === false ? smoke : null;
  return {
    status: failedSmoke ? "unavailable" : "available",
    checkedAt,
    message: failedSmoke
      ? (failedSmoke.error ?? "LibreOffice conversion smoke test failed.")
      : "LibreOffice is available through the Cowork-managed soffice shim.",
    version,
    shimPath: setup.shimPath,
    resolvedPath,
    rootDir: setup.rootDir,
    ...(smoke ? { smoke } : {}),
  };
}
