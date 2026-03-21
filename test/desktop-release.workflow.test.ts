import { readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

const workflowPath = new URL("../.github/workflows/desktop-release.yml", import.meta.url);
const workflow = readFileSync(workflowPath, "utf8");

describe("desktop release workflow", () => {
  test("separates macOS and Windows signing credentials", () => {
    expect(workflow).toMatch(
      /- name: Build macOS desktop artifacts[\s\S]*?CSC_LINK: \$\{\{ secrets\.CSC_LINK \}\}[\s\S]*?CSC_KEY_PASSWORD: \$\{\{ secrets\.CSC_KEY_PASSWORD \}\}/,
    );
    expect(workflow).toMatch(
      /- name: Build Windows desktop artifacts[\s\S]*?if \(\$env:WIN_CSC_LINK -and \$env:WIN_CSC_KEY_PASSWORD\)[\s\S]*?\$env:CSC_LINK = \$env:WIN_CSC_LINK[\s\S]*?\$env:CSC_KEY_PASSWORD = \$env:WIN_CSC_KEY_PASSWORD/,
    );
    expect(workflow).not.toMatch(
      /- name: Build Windows desktop artifacts[\s\S]*?CSC_LINK: \$\{\{ secrets\.CSC_LINK \}\}/,
    );
  });

  test("builds separate Windows x64 and ARM64 release entries", () => {
    expect(workflow).toContain("label: Windows x64");
    expect(workflow).toContain("artifact_name: desktop-release-windows-x64");
    expect(workflow).toContain("build_arch: x64");
    expect(workflow).toContain("label: Windows ARM64");
    expect(workflow).toContain("artifact_name: desktop-release-windows-arm64");
    expect(workflow).toContain("build_arch: arm64");
    expect(workflow).toContain("updater_metadata_name: latest-arm64.yml");
  });

  test("uses target-aware Windows build inputs and stages ARM64 updater metadata separately", () => {
    expect(workflow).toMatch(
      /- name: Build Windows desktop artifacts[\s\S]*?COWORK_BUILD_PLATFORM: win32[\s\S]*?COWORK_BUILD_ARCH: \$\{\{ matrix\.build_arch \}\}[\s\S]*?bun run desktop:build -- --publish never --\$\{\{ matrix\.build_arch \}\}/,
    );
    expect(workflow).toMatch(
      /- name: Stage Windows desktop release assets[\s\S]*?apps\/desktop\/release\/\*-win-\$\{\{ matrix\.build_arch \}\}\.exe[\s\S]*?Copy-Item "apps\/desktop\/release\/latest\.yml" -Destination \(Join-Path \$stagingDir "\$\{\{ matrix\.updater_metadata_name \}\}"\)/,
    );
    expect(workflow).toContain("Windows signing secrets configured; publishing signed installer plus updater metadata.");
    expect(workflow).toContain("WIN_CSC_LINK/WIN_CSC_KEY_PASSWORD not configured; publishing unsigned installer plus updater metadata.");
  });

  test("ARM64 unpacked artifact is for smoke only and excluded from publish download glob", () => {
    expect(workflow).toContain("pattern: desktop-release-*");
    expect(workflow).toContain("unpacked_artifact_name: desktop-smoke-windows-arm64-unpacked");
    expect(workflow).toContain("name: desktop-smoke-windows-arm64-unpacked");
  });

  test("uploads an unpacked ARM64 desktop artifact and verifies it on native ARM hardware", () => {
    expect(workflow).toContain("- name: Build Windows ARM64 unpacked desktop directory");
    expect(workflow).toContain("runs-on: windows-11-arm");
    expect(workflow).toContain("name: Smoke Windows ARM64 Desktop");
    expect(workflow).toContain("COWORK_DESKTOP_SMOKE_WORKSPACE");
    expect(workflow).toContain("COWORK_DESKTOP_SMOKE_OUTPUT");
    expect(workflow).toContain("Start-Process -FilePath $appExe.FullName -WorkingDirectory $appExe.DirectoryName -PassThru");
    expect(workflow).toContain("Desktop smoke output was not written within");
    expect(workflow).toContain("Packaged ARM64 desktop smoke run exited before writing output");
    expect(workflow).toContain("Expected desktop smoke output type=server_listening");
  });

  test("publishes release assets only after the ARM64 smoke job passes", () => {
    expect(workflow).toMatch(
      /publish:[\s\S]*?needs:[\s\S]*?- package[\s\S]*?- smoke-windows-arm64/,
    );
    expect(workflow).toContain("- name: Collect release asset list");
    expect(workflow).toContain("files: ${{ steps.collect-release-assets.outputs.files }}");
  });
});
