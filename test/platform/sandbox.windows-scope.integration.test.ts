import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { hostPlatform } from "../../src/platform/host";
import { resolveSandboxPolicy, scratchRoots } from "../../src/platform/sandbox/policy";
import { buildWindowsSandboxCommand, windowsSandboxHome } from "../../src/platform/sandbox/windows";

const helper = path.resolve(
  process.env.COWORK_WIN_SANDBOX_HELPER ??
    "crates/cowork-win-sandbox/target/release/cowork-win-sandbox.exe",
);
const nativeDescribe =
  hostPlatform() === "win32" && process.env.RUN_WINDOWS_SANDBOX_INTEGRATION === "1"
    ? describe
    : describe.skip;

// Opt-in: requires a rebuilt, trusted helper and an already configured Windows
// sandbox. No network calls or setup are performed by the test itself.
nativeDescribe("Windows explicit TEMP scope enforcement", () => {
  test("permits a TEMP child target but blocks its sibling and an empty native scope", () => {
    expect(fs.existsSync(helper)).toBe(true);
    const project = fs.mkdtempSync(path.join(scratchRoots("win32")[0], "cowork-win-scope-"));
    const target = path.join(project, "src");
    fs.mkdirSync(target);
    const allowed = path.join(target, "allowed.txt");
    const sibling = path.join(project, "sibling.txt");
    const emptyDenied = path.join(project, "empty-denied.txt");
    try {
      const policy = resolveSandboxPolicy({
        config: { mode: "workspace-write", network: false },
        workingDirectory: project,
        targetPaths: ["src"],
      });
      const write = (destination: string) => {
        const command = buildWindowsSandboxCommand(
          { file: helper, args: ["probe-grandchild", destination] },
          policy,
          project,
          helper,
          windowsSandboxHome(),
        );
        return spawnSync(command.file, command.args, { encoding: "utf8", timeout: 30_000 });
      };
      const allowedResult = write(allowed);
      expect(allowedResult.error).toBeUndefined();
      expect(allowedResult.status).toBe(0);
      expect(fs.readFileSync(allowed, "utf8")).toBe("escape");
      expect(write(sibling).status).toBe(9);
      expect(fs.existsSync(sibling)).toBe(false);

      // Exercise the native argv parser with literally zero writable roots,
      // not the TS wrapper's intentional scratch-only empty workspace policy.
      const emptyResult = spawnSync(
        helper,
        [
          "run",
          "--mode",
          "workspace-write",
          "--cwd",
          project,
          "--sandbox-home",
          windowsSandboxHome(),
          "--",
          helper,
          "probe-grandchild",
          emptyDenied,
        ],
        { encoding: "utf8", timeout: 30_000 },
      );
      expect(emptyResult.error).toBeUndefined();
      expect(emptyResult.status).toBe(9);
      expect(fs.existsSync(emptyDenied)).toBe(false);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  }, 120_000);
});
