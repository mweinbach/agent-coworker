import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const workflowPath = new URL("../.github/workflows/desktop-release.yml", import.meta.url);
const workflow = readFileSync(workflowPath, "utf8");

describe("desktop release workflow", () => {
  test("runs validation for tag-triggered releases before packaging", () => {
    const validateJob = workflow.match(/validate:[\s\S]*?\n {2}package:/)?.[0] ?? "";
    const packageJob = workflow.match(/package:[\s\S]*?\n {2}smoke-windows-arm64:/)?.[0] ?? "";

    expect(validateJob).toContain("name: Validate");
    expect(validateJob).not.toContain("if: github.event_name == 'workflow_dispatch'");
    expect(packageJob).toContain("needs: validate");
    expect(packageJob).toContain("if: ${{ needs.validate.result == 'success' }}");
    expect(packageJob).not.toContain("needs.validate.result == 'skipped'");
  });

  test("uses isolated stable tests for release validation", () => {
    const validateJob = workflow.match(/validate:[\s\S]*?\n {2}package:/)?.[0] ?? "";

    expect(validateJob).toContain("run: bun run test:stable -- --max-concurrency 1");
    expect(validateJob).not.toContain("run: bun test --max-concurrency 1");
  });

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

  test("passes only public telemetry variables into desktop package builds", () => {
    const packageJob = workflow.match(/package:[\s\S]*?\n {2}smoke-windows-arm64:/)?.[0] ?? "";

    expect(packageJob).toContain("COWORK_SENTRY_DSN: ${{ vars.COWORK_SENTRY_DSN }}");
    expect(packageJob).toContain("COWORK_POSTHOG_KEY: ${{ vars.COWORK_POSTHOG_KEY }}");
    expect(packageJob).toContain("COWORK_POSTHOG_HOST: ${{ vars.COWORK_POSTHOG_HOST }}");
    expect(packageJob).toContain("LANGFUSE_BASE_URL: ${{ vars.LANGFUSE_BASE_URL }}");
    expect(packageJob).toContain("LANGFUSE_PUBLIC_KEY: ${{ vars.LANGFUSE_PUBLIC_KEY }}");
    expect(packageJob).toContain("- name: Validate public telemetry build variables");
    expect(packageJob).toContain("Missing required public telemetry GitHub variables");
    expect(packageJob).toContain(
      "Forbidden telemetry variables must not be present in the public desktop build",
    );
    expect(packageJob).toContain("LANGFUSE_SECRET_KEY");
    expect(packageJob).toContain("COWORK_DIAGNOSTICS_UPLOAD_URL");
    expect(packageJob).toContain("COWORK_CLOUD_SYNC_ENDPOINT");
    expect(workflow).not.toMatch(/secrets\.LANGFUSE_SECRET_KEY/);
    expect(workflow).not.toMatch(/vars\.COWORK_DIAGNOSTICS_UPLOAD_URL/);
    expect(workflow).not.toMatch(/vars\.COWORK_CLOUD_SYNC_ENDPOINT/);
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
    expect(workflow).toContain(
      "Windows signing secrets configured; publishing signed installer plus updater metadata.",
    );
    expect(workflow).toContain(
      "WIN_CSC_LINK/WIN_CSC_KEY_PASSWORD not configured; publishing unsigned installer plus updater metadata.",
    );
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
    expect(workflow).toContain(
      'Get-ChildItem "apps/desktop/release" -Recurse -Filter "cowork-server-manifest.json" -File |',
    );
    expect(workflow.replace(/\s+/g, " ")).toContain(
      'Where-Object { $_.FullName -match "\\\\win-arm64-unpacked\\\\resources\\\\binaries\\\\" }',
    );
    expect(workflow).toContain(
      'throw "ARM64 unpacked desktop directory did not include cowork-server-manifest.json under win-arm64-unpacked/resources/binaries"',
    );
    expect(workflow).toContain(
      'throw "ARM64 unpacked manifest was found outside resources\\\\binaries: $sidecarRoot"',
    );
    expect(workflow).toContain(
      'throw "ARM64 unpacked sidecar manifest does not point at the expected Bun runtime payload"',
    );
    expect(workflow).not.toContain("managed-soffice-helper.mjs");
    expect(workflow).toContain("COWORK_DESKTOP_SMOKE_WORKSPACE");
    expect(workflow).toContain("COWORK_DESKTOP_SMOKE_OUTPUT");
    expect(workflow).toContain(
      "Start-Process -FilePath $appExe.FullName -WorkingDirectory $appExe.DirectoryName -PassThru",
    );
    expect(workflow).toContain("Desktop smoke output was not written within");
    expect(workflow).toContain("Packaged ARM64 desktop smoke run exited before writing output");
    expect(workflow).toContain("Expected desktop smoke output type=server_listening");
    expect(workflow).toContain(
      "Expected desktop smoke run to confirm a packaged system prompt load",
    );
    expect(workflow).toContain(
      "Expected desktop smoke run to exercise the packaged first-turn path",
    );
  });

  test("publishes release assets only after the ARM64 smoke job passes", () => {
    expect(workflow).toMatch(
      /smoke-windows-arm64:[\s\S]*?if: \$\{\{ always\(\) && needs\.package\.result == 'success' \}\}/,
    );
    expect(workflow).toMatch(
      /publish:[\s\S]*?needs:[\s\S]*?- package[\s\S]*?- smoke-windows-arm64[\s\S]*?if: \$\{\{ always\(\) && startsWith\(github\.ref, 'refs\/tags\/'\) && needs\.package\.result == 'success' && needs\.smoke-windows-arm64\.result == 'success' \}\}/,
    );
    expect(workflow).toContain("- name: Collect release asset list");
    expect(workflow).toContain("files: ${{ steps.collect-release-assets.outputs.files }}");
  });
});
