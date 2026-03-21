import { readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

const workflowPath = new URL("../.github/workflows/cowork-server-release.yml", import.meta.url);
const workflow = readFileSync(workflowPath, "utf8");

describe("cowork-server release workflow", () => {
  test("keeps repo validation gates in front of release builds", () => {
    expect(workflow).toContain("- name: Unit tests");
    expect(workflow).toContain("- name: Typecheck");
    expect(workflow).toContain("- name: Docs consistency check");
  });

  test("builds separate Windows x64 and ARM64 server bundles", () => {
    expect(workflow).toContain("label: Windows x64");
    expect(workflow).toContain("artifact_name: cowork-server-windows-x64");
    expect(workflow).toContain("launcher_path: dist/cowork-server-windows-x64/cowork-server.exe");
    expect(workflow).toContain("label: Windows ARM64");
    expect(workflow).toContain("artifact_name: cowork-server-windows-arm64");
    expect(workflow).toContain("launcher_path: dist/cowork-server-windows-arm64/cowork-server.cmd");
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

  test("verifies the ARM64 Windows server launcher on native ARM hardware before publish", () => {
    expect(workflow).toContain("name: Smoke cowork-server Windows ARM64");
    expect(workflow).toContain("runs-on: windows-11-arm");
    expect(workflow).toContain("cowork-server.cmd");
    expect(workflow).toContain("--json");
    expect(workflow).toContain("server_listening");
  });

  test("blocks prerelease publishing on the ARM64 smoke job", () => {
    expect(workflow).toMatch(
      /publish:[\s\S]*?needs:[\s\S]*?- build[\s\S]*?- smoke-windows-arm64/,
    );
    expect(workflow).toContain("files: ${{ steps.collect.outputs.files }}");
  });
});
