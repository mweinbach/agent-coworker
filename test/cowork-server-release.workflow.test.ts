import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const workflowPath = new URL("../.github/workflows/cowork-server-release.yml", import.meta.url);
const workflow = readFileSync(workflowPath, "utf8");
const serverBuildScriptPath = new URL("../scripts/build_cowork_server_binary.ts", import.meta.url);
const serverBuildScript = readFileSync(serverBuildScriptPath, "utf8");

describe("cowork-server release workflow", () => {
  test("runs validation for tag-triggered releases before builds", () => {
    const validateJob = workflow.match(/validate:[\s\S]*?\n {2}build:/)?.[0] ?? "";
    const buildJob = workflow.match(/build:[\s\S]*?\n {2}smoke-windows-arm64:/)?.[0] ?? "";

    expect(validateJob).toContain("name: Validate");
    expect(validateJob).not.toContain("if: github.event_name == 'workflow_dispatch'");
    expect(buildJob).toContain("needs: validate");
    expect(buildJob).toContain("if: ${{ needs.validate.result == 'success' }}");
    expect(buildJob).not.toContain("needs.validate.result == 'skipped'");
  });

  test("keeps repo validation gates in front of release builds", () => {
    expect(workflow).toContain("- name: Unit tests");
    expect(workflow).toMatch(/- name: Unit tests\s*\n\s*run: bun run test\n/);
    expect(workflow).not.toContain("--max-concurrency");
    expect(workflow).not.toContain("run: bun run test:stable");
    expect(workflow).toContain("- name: Typecheck");
    expect(workflow).toContain("- name: Docs consistency check");
  });

  test("installs locked mobile dependencies before running the full release test suite", () => {
    const validateJob = workflow.match(/validate:[\s\S]*?\n {2}build:/)?.[0] ?? "";
    const install = validateJob.indexOf("bun install --cwd apps/mobile --frozen-lockfile");
    expect(install).toBeGreaterThan(-1);
    expect(install).toBeLessThan(validateJob.indexOf("run: bun run test"));
    expect(validateJob).toContain("apps/mobile/bun.lock");
    expect(validateJob).toContain("apps/mobile/package.json");
  });

  test("builds separate Windows x64 and ARM64 server bundles", () => {
    expect(workflow).toContain("label: Windows x64");
    expect(workflow).toContain("artifact_name: cowork-server-windows-x64");
    expect(workflow).toContain("launcher_path: dist/cowork-server-windows-x64/cowork-server.exe");
    expect(workflow).toContain("label: Windows ARM64");
    expect(workflow).toContain("artifact_name: cowork-server-windows-arm64");
    expect(workflow).toContain("launcher_path: dist/cowork-server-windows-arm64/cowork-server.exe");
    expect(workflow).not.toContain("cowork-server.cmd");
  });

  test("compiles target-native standalone executables without bundling a separate Bun runtime", () => {
    expect(serverBuildScript).toContain("resolveBunCompileTarget(target.platform, target.arch)");
    expect(serverBuildScript).not.toContain("ensureBundledBunRuntime");
    expect(serverBuildScript).not.toContain("buildBunBundle");
    expect(serverBuildScript).not.toContain('env: "inline"');
    expect(serverBuildScript).not.toContain("--windows-hide-console");
    expect(serverBuildScript).not.toContain("Cross-compiling cowork-server is unsupported");
  });

  test("passes target-aware build inputs and packages runnable bundles instead of loose binaries", () => {
    expect(workflow).toMatch(
      /- name: Build cowork-server binary[\s\S]*?COWORK_BUILD_PLATFORM: \$\{\{ matrix\.target_platform \}\}[\s\S]*?COWORK_BUILD_ARCH: \$\{\{ matrix\.target_arch \}\}[\s\S]*?bun run build:server-binary -- --outfile \$\{\{ matrix\.launcher_path \}\}/,
    );
    expect(workflow).toContain("- name: Package macOS bundle");
    expect(workflow).toContain("zip -r $(basename ${{ matrix.zip_path }}) cowork-server-macos");
    expect(workflow).toContain("- name: Package Windows bundle");
    expect(workflow).toContain("Compress-Archive -Path $bundleDir -DestinationPath");
  });

  test("verifies the ARM64 Windows executable directly on native ARM hardware before publish", () => {
    expect(workflow).toContain("name: Smoke cowork-server Windows ARM64");
    expect(workflow).toContain("runs-on: windows-11-arm");
    expect(workflow).toContain('-Filter "cowork-server.exe"');
    expect(workflow).toContain("Start-Process -FilePath $launcher.FullName");
    expect(workflow).not.toContain('Start-Process -FilePath "cmd.exe"');
    expect(workflow).toContain("$peSignature -ne 0x00004550");
    expect(workflow).toContain("$machine -ne 0xAA64");
    expect(workflow).toContain("--json");
    expect(workflow).toContain("server_listening");
  });

  test("checks sandbox hashes and native enforcement from the extracted standalone bundle", () => {
    const smokeJob = workflow.match(/smoke-windows-arm64:[\s\S]*?\n {2}publish:/)?.[0] ?? "";
    expect(smokeJob).toContain("$bundleDir = $launcher.Directory.FullName");
    expect(smokeJob).toContain('Join-Path $bundleDir "cowork-win-sandbox.sha256.json"');
    expect(smokeJob).toContain("Get-FileHash -Algorithm SHA256 -LiteralPath $helperPath");
    expect(smokeJob).toContain("$sandboxHelper setup --sandbox-home");
    expect(smokeJob).toContain("failed the native sandbox setup and enforcement probe");
    expect(smokeJob.indexOf("$sandboxHelper setup")).toBeLessThan(
      smokeJob.indexOf("Start-Process -FilePath $launcher.FullName"),
    );
  });

  test("blocks prerelease publishing on the ARM64 smoke job", () => {
    expect(workflow).toMatch(/publish:[\s\S]*?needs:[\s\S]*?- build[\s\S]*?- smoke-windows-arm64/);
    expect(workflow).toContain("files: ${{ steps.collect.outputs.files }}");
  });
});
