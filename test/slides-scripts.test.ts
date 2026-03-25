import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { withGlobalTestLock } from "./shared/processLock";

function repoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..");
}

function slidesScriptsDir(): string {
  return path.join(repoRoot(), "skills", "slides", "scripts");
}

function resolvePythonInvocation(): { command: string; args: string[] } {
  const candidates =
    process.platform === "win32"
      ? [
          { command: "py", args: ["-3"] },
          { command: "python", args: [] },
        ]
      : [
          { command: "python3", args: [] },
          { command: "python", args: [] },
        ];

  for (const candidate of candidates) {
    const probe = spawnSync(candidate.command, [...candidate.args, "--version"], {
      encoding: "utf-8",
    });
    if (probe.status === 0) return candidate;
  }

  throw new Error("Python 3 is required for slides script tests.");
}

function runPython(code: string): string {
  const python = resolvePythonInvocation();
  const pythonPath = [slidesScriptsDir(), process.env.PYTHONPATH].filter(Boolean).join(path.delimiter);
  const result = spawnSync(python.command, [...python.args, "-c", code], {
    cwd: repoRoot(),
    encoding: "utf-8",
    env: {
      ...process.env,
      PYTHONPATH: pythonPath,
    },
  });

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `Python exited with status ${result.status}`);
  }

  return result.stdout.trim();
}

function runPythonWithOutputFile(code: string): string {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "slides-script-output-"));
  const outputPath = path.join(outputDir, "result.txt");
  try {
    runPython(`output_path = ${JSON.stringify(outputPath)}\n${code}`);
    return fs.readFileSync(outputPath, "utf-8").trim();
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
}

describe("slides script executable resolution", () => {
  test("includes cross-platform LibreOffice and Ghostscript candidates", async () => {
    const output = await withGlobalTestLock("subprocess-env", async () => runPythonWithOutputFile(`
import json
from executable_resolution import libreoffice_search_candidates, ghostscript_search_candidates

payload = {
    "libreoffice_win32": libreoffice_search_candidates(
        platform="win32",
        env={
            "ProgramFiles": r"C:\\Program Files",
            "ProgramFiles(x86)": r"C:\\Program Files (x86)",
            "LOCALAPPDATA": r"C:\\Users\\Test\\AppData\\Local",
        },
    ),
    "libreoffice_darwin": libreoffice_search_candidates(platform="darwin", env={}),
    "ghostscript_win32": ghostscript_search_candidates(
        platform="win32",
        env={
            "ProgramFiles": r"C:\\Program Files",
            "ProgramFiles(x86)": r"C:\\Program Files (x86)",
        },
    ),
}
with open(output_path, "w", encoding="utf-8") as handle:
    handle.write(json.dumps(payload))
`));

    const parsed = JSON.parse(output) as Record<string, string[]>;
    expect(parsed.libreoffice_win32).toContain("soffice");
    expect(parsed.libreoffice_win32.some((value) => value.endsWith("LibreOffice\\program\\soffice.exe"))).toBe(true);
    expect(parsed.libreoffice_darwin).toContain("/Applications/LibreOffice.app/Contents/MacOS/soffice");
    expect(parsed.ghostscript_win32).toContain("gswin64c.exe");
    expect(parsed.ghostscript_win32).toContain("gswin32c.exe");
  });

  test("raises clear override errors for missing Windows slide dependencies", async () => {
    const output = await withGlobalTestLock("subprocess-env", async () => runPythonWithOutputFile(`
from executable_resolution import MissingDependencyError, resolve_libreoffice_executable

try:
    resolve_libreoffice_executable(
        platform="win32",
        env={"COWORK_SLIDES_LIBREOFFICE_BIN": "missing-soffice.exe"},
        which=lambda name: None,
    )
except MissingDependencyError as exc:
    with open(output_path, "w", encoding="utf-8") as handle:
        handle.write(str(exc))
`));

    expect(output).toContain("LibreOffice executable configured via COWORK_SLIDES_LIBREOFFICE_BIN was not found");
    expect(output).toContain("Update COWORK_SLIDES_LIBREOFFICE_BIN");
  });

  test("raises actionable missing-dependency messages for Linux and Windows helpers", async () => {
    const output = await withGlobalTestLock("subprocess-env", async () => runPythonWithOutputFile(`
import json
from executable_resolution import (
    MissingDependencyError,
    resolve_fontconfig_executable,
    resolve_inkscape_executable,
)

messages = {}
for key, resolver, platform_name in [
    ("fontconfig", resolve_fontconfig_executable, "win32"),
    ("inkscape", resolve_inkscape_executable, "linux"),
]:
    try:
        resolver(platform=platform_name, env={}, which=lambda name: None)
    except MissingDependencyError as exc:
        messages[key] = str(exc)

with open(output_path, "w", encoding="utf-8") as handle:
    handle.write(json.dumps(messages))
`));

    const parsed = JSON.parse(output) as Record<string, string>;
    expect(parsed.fontconfig).toContain("fontconfig (fc-list) executable not found");
    expect(parsed.fontconfig).toContain("Set COWORK_SLIDES_FONTCONFIG_BIN");
    expect(parsed.inkscape).toContain("Inkscape executable not found");
    expect(parsed.inkscape).toContain("Set COWORK_SLIDES_INKSCAPE_BIN");
  });
});
