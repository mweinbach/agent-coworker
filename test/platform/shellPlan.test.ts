import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import {
  buildPlatformShellExecutionPlan,
  commands,
  encodingPrelude,
  promptGuidance,
  pythonInvocation,
} from "../../src/platform/shell";
import { codexDeveloperInstructions } from "../../src/runtime/codexAppServer/config";
import { __internal as bashInternal } from "../../src/tools/bash";

function decodeEncodedCommand(args: string[]): string {
  const idx = args.indexOf("-EncodedCommand");
  expect(idx).toBeGreaterThan(-1);
  return Buffer.from(args[idx + 1] as string, "base64").toString("utf16le");
}

const EXIT_GUARD = "if ((Test-Path -LiteralPath variable:\\LASTEXITCODE)) { exit $LASTEXITCODE }";

describe("buildPlatformShellExecutionPlan — win32 EncodedCommand transport", () => {
  test("golden argv: pwsh then powershell.exe, flags, opaque payload, displayCommand", () => {
    const plan = buildPlatformShellExecutionPlan("win32", "echo hi");
    expect(plan.map((s) => s.file)).toEqual(["pwsh", "powershell.exe"]);
    for (const step of plan) {
      expect(step.args.slice(0, 4)).toEqual([
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
      ]);
      expect(step.args[4]).toBe("-EncodedCommand");
      expect(step.displayCommand).toBe("echo hi");
      expect(step.tempScript).toBeUndefined();
    }
  });

  test("decoded script = encoding prelude + command + exit-code guard", () => {
    const [step] = buildPlatformShellExecutionPlan("win32", "git status");
    const script = decodeEncodedCommand((step as { args: string[] }).args);
    expect(script).toBe(`${encodingPrelude("win32")}\ngit status\n${EXIT_GUARD}`);
    expect(script).toContain("[System.Text.Encoding]::UTF8");
    expect(script).toContain("$env:PYTHONUTF8 = '1'");
  });

  test("quotes, backticks, dollars, and unicode survive byte-exact (one parse layer)", () => {
    const gnarly = `git commit -m "fix: it's \\"quoted\\" — costs $5, uses \`backticks\` and trailing\\"`;
    const [step] = buildPlatformShellExecutionPlan("win32", gnarly);
    const script = decodeEncodedCommand((step as { args: string[] }).args);
    expect(script).toContain(gnarly);
  });

  test("multi-line scripts pass through unmodified", () => {
    const multi = "Get-ChildItem\nif ($?) {\n  Write-Output 'ok'\n}";
    const [step] = buildPlatformShellExecutionPlan("win32", multi);
    expect(decodeEncodedCommand((step as { args: string[] }).args)).toContain(multi);
  });

  test("oversized command switches to -File temp script with embedded BOM", () => {
    const big = `echo ${"x".repeat(15000)}`;
    const plan = buildPlatformShellExecutionPlan("win32", big, {
      tempDir: "C:\\Temp",
      scriptId: "fixed-id",
    });
    expect(plan.map((s) => s.file)).toEqual(["pwsh", "powershell.exe"]);
    for (const step of plan) {
      expect(step.args).toEqual([
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        "C:\\Temp\\cowork-shell-fixed-id.ps1",
      ]);
      expect(step.tempScript?.path).toBe("C:\\Temp\\cowork-shell-fixed-id.ps1");
      expect(step.tempScript?.content.charCodeAt(0)).toBe(0xfeff);
      expect(step.tempScript?.content).toContain(big);
      expect(step.tempScript?.content).toContain(EXIT_GUARD);
      expect(step.displayCommand).toBe(big);
    }
    // Both steps share the one script object.
    expect(plan[0]?.tempScript).toBe(plan[1]?.tempScript as never);
  });

  test("command-line length stays under the CreateProcess ceiling in both modes", () => {
    for (const command of ["echo hi", `echo ${"y".repeat(60000)}`]) {
      const [step] = buildPlatformShellExecutionPlan("win32", command);
      const commandLine = ["pwsh", ...(step as { args: string[] }).args].join(" ");
      expect(commandLine.length).toBeLessThan(32767);
    }
  });
});

describe("buildPlatformShellExecutionPlan — POSIX", () => {
  test("bash -lc single argv element, no transport wrapping", () => {
    const cmd = `git commit -m "it's fine"`;
    const plan = buildPlatformShellExecutionPlan("linux", cmd, { userShell: "/bin/zsh" });
    expect(plan[0]).toMatchObject({ file: "/bin/zsh", args: ["-lc", cmd], displayCommand: cmd });
    expect(plan.map((s) => s.file)).toEqual(["/bin/zsh", "/bin/bash", "/bin/sh", "bash", "sh"]);
  });

  test("encoding prelude is empty on POSIX", () => {
    expect(encodingPrelude("linux")).toBe("");
    expect(encodingPrelude("darwin")).toBe("");
  });

  test("sh-compatible $SHELL is honored (zsh, dash, versioned paths)", () => {
    for (const shell of ["/opt/homebrew/bin/zsh", "/usr/bin/dash", "/usr/local/bin/bash"]) {
      const plan = buildPlatformShellExecutionPlan("darwin", "pwd", { userShell: shell });
      expect(plan[0]?.file).toBe(shell);
    }
  });

  test("fish/nushell/pwsh $SHELL is skipped — plan starts at /bin/bash", () => {
    for (const shell of ["/usr/bin/fish", "/usr/bin/nu", "/usr/local/bin/pwsh"]) {
      const plan = buildPlatformShellExecutionPlan("darwin", "pwd", { userShell: shell });
      expect(plan[0]?.file).toBe("/bin/bash");
    }
  });
});

describe("pythonInvocation — the one Python answer", () => {
  test("managed runtime interpreter wins on every platform", () => {
    const env = { COWORK_RUNTIME_PYTHON: "C:\\rt\\python\\python.exe" };
    expect(pythonInvocation(env, "win32").display).toBe("C:\\rt\\python\\python.exe");
    expect(pythonInvocation({ cowork_runtime_python: "/rt/bin/python" }, "win32").display).toBe(
      "/rt/bin/python",
    );
  });

  test("bare fallback: python on win32 (PATH prelude resolves it), python3 on POSIX", () => {
    expect(pythonInvocation({}, "win32").display).toBe("python");
    expect(pythonInvocation({}, "darwin").display).toBe("python3");
    expect(pythonInvocation({}, "linux").display).toBe("python3");
  });

  test("never py -3", () => {
    for (const platform of ["win32", "darwin", "linux"] as const) {
      expect(pythonInvocation({}, platform).display).not.toContain("py -3");
      expect(promptGuidance({ platform, env: {} })).not.toContain("prefer `py -3`");
    }
  });
});

describe("promptGuidance — single dialect, module-owned", () => {
  test("win32 renders PowerShell rules only", () => {
    const text = promptGuidance({ platform: "win32", env: {} });
    expect(text).toContain("executes PowerShell on this machine");
    expect(text).toContain("$env:NAME");
    expect(text).not.toContain("executes bash");
  });

  test("posix renders bash rules only", () => {
    const text = promptGuidance({ platform: "linux", env: {} });
    expect(text).toContain("executes bash on this machine");
    expect(text).not.toContain("PowerShell");
  });

  test("codex executor renders nothing — Codex owns its shell", () => {
    expect(promptGuidance({ platform: "win32", executor: "codex" })).toBe("");
  });
});

describe("codexDeveloperInstructions strips the Shell Execution Policy section", () => {
  test("host shell rules never reach a Codex turn", () => {
    const system = [
      "Base prompt.",
      "",
      "## Shell Execution Policy",
      "",
      promptGuidance({ platform: "win32", env: {} }),
      "",
      "## Another Section",
      "",
      "Kept.",
    ].join("\n");
    const rendered = codexDeveloperInstructions(system);
    expect(rendered).not.toContain("Shell Execution Policy");
    expect(rendered).not.toContain("executes PowerShell");
    expect(rendered).toContain("Base prompt.");
    expect(rendered).toContain("## Another Section");
    expect(rendered).toContain("Kept.");
  });

  test("section at end of prompt is stripped too", () => {
    const system = `Base.\n\n## Shell Execution Policy\n\n${promptGuidance({ platform: "linux", env: {} })}`;
    const rendered = codexDeveloperInstructions(system);
    expect(rendered).not.toContain("Shell Execution Policy");
    expect(rendered).toContain("Base.");
  });
});

describe("commands — canned cross-platform command strings", () => {
  test("powershell shapes with safe quoting", () => {
    const c = commands("win32", {});
    expect(c.runPythonScript("build it.py")).toBe("python 'build it.py'");
    expect(c.printWorkingDirectory()).toBe("(Get-Location).Path");
    expect(c.listDirectory("C:\\my dir")).toBe("Get-ChildItem -Force 'C:\\my dir'");
    expect(c.countLines("notes.md")).toBe("(Get-Content 'notes.md' | Measure-Object -Line).Lines");
  });

  test("quoted interpreter paths get the call operator", () => {
    const c = commands("win32", { COWORK_RUNTIME_PYTHON: "C:\\Program Files\\rt\\python.exe" });
    expect(c.runPythonScript("s.py")).toBe("& 'C:\\Program Files\\rt\\python.exe' 's.py'");
  });

  test("PowerShell metacharacters in managed interpreter paths stay literal", () => {
    for (const interpreter of [
      "C:\\Tools&Co\\python.exe",
      "C:\\Tools;Co\\python.exe",
      "C:\\Tools(Co)\\python.exe",
      "C:\\Tools`Co\\python.exe",
    ]) {
      const c = commands("win32", { COWORK_RUNTIME_PYTHON: interpreter });
      expect(c.runPythonScript("s.py")).toBe(`& '${interpreter}' 's.py'`);
    }
  });

  test("posix shapes", () => {
    const c = commands("linux", {});
    expect(c.runPythonScript("it's.py")).toBe("'python3' 'it'\\''s.py'");
    expect(c.printWorkingDirectory()).toBe("pwd");
    expect(c.listDirectory()).toBe("ls -la");
    expect(c.countLines("a.md")).toBe("wc -l 'a.md'");
  });
});

describe("runShellCommandWithExec temp-script lifecycle", () => {
  test("materializes the -File script before spawn and removes it after", async () => {
    const big = `echo ${"z".repeat(15000)}`;
    let sawPath: string | undefined;
    let existedDuringRun = false;
    let contentDuringRun = "";
    const result = await bashInternal.runShellCommandWithExec({
      command: big,
      cwd: import.meta.dir,
      platform: "win32",
      execRunner: async (_file: string, args: string[]) => {
        sawPath = args[args.indexOf("-File") + 1];
        existedDuringRun = fs.existsSync(sawPath as string);
        contentDuringRun = fs.readFileSync(sawPath as string, "utf8");
        return { stdout: "ok", stderr: "", exitCode: 0 };
      },
    });
    expect(result.exitCode).toBe(0);
    expect(sawPath).toBeTruthy();
    expect(path.win32.basename(sawPath as string)).toStartWith("cowork-shell-");
    expect(existedDuringRun).toBe(true);
    expect(contentDuringRun).toContain(big);
    expect(fs.existsSync(sawPath as string)).toBe(false);
  });

  test("removes the script even when every candidate is ENOENT", async () => {
    const big = `echo ${"q".repeat(15000)}`;
    const seen: string[] = [];
    const result = await bashInternal.runShellCommandWithExec({
      command: big,
      cwd: import.meta.dir,
      platform: "win32",
      execRunner: async (_file: string, args: string[]) => {
        seen.push(args[args.indexOf("-File") + 1] as string);
        return { stdout: "", stderr: "", exitCode: 1, errorCode: "ENOENT" };
      },
    });
    expect(result.errorCode).toBe("ENOENT");
    expect(seen.length).toBe(2);
    expect(fs.existsSync(seen[0] as string)).toBe(false);
  });
});
