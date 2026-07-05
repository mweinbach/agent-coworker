import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const workflowPath = new URL("../.github/workflows/desktop-release.yml", import.meta.url);
const workflow = readFileSync(workflowPath, "utf8");
const builderConfig = readFileSync(
  new URL("../apps/desktop/electron-builder.yml", import.meta.url),
  "utf8",
);

describe("desktop release workflow", () => {
  test("runs validation for tag-triggered releases before packaging", () => {
    const validateJob = workflow.match(/validate:[\s\S]*?\n {2}package:/)?.[0] ?? "";
    const packageJob = workflow.match(/package:[\s\S]*?\n {2}publish:/)?.[0] ?? "";

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
      /- name: Build Windows desktop artifacts[\s\S]*?\$env:CSC_LINK = \$env:WIN_CSC_LINK[\s\S]*?\$env:CSC_KEY_PASSWORD = \$env:WIN_CSC_KEY_PASSWORD/,
    );
    expect(workflow).not.toMatch(
      /- name: Build Windows desktop artifacts[\s\S]*?CSC_LINK: \$\{\{ secrets\.CSC_LINK \}\}/,
    );
  });

  test("builds and strictly verifies the native Apple Silicon release", () => {
    expect(workflow).toContain("- os: macos-15");
    expect(workflow).toMatch(/label: macOS[\s\S]*?build_arch: arm64/);
    expect(workflow).toContain("- name: Verify native macOS sandbox and runtime");
    expect(workflow).toMatch(
      /- name: Build macOS desktop artifacts[\s\S]*?COWORK_BUILD_PLATFORM: darwin[\s\S]*?COWORK_BUILD_ARCH: arm64[\s\S]*?desktop:build -- --publish never --arm64/,
    );
    expect(workflow).toContain('codesign --verify --deep --strict --verbose=4 "$app_path"');
    expect(workflow).toContain('xcrun stapler validate "$app_path"');
    expect(workflow).toContain('spctl -a -vv --type exec "$app_path"');
  });

  test("passes only public telemetry variables into desktop package builds", () => {
    const packageJob = workflow.match(/package:[\s\S]*?\n {2}publish:/)?.[0] ?? "";

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
    expect(workflow).toContain("- name: Configure Windows signing");
    expect(workflow).toContain("COWORK_WIN_SIGN_RELEASE=true");
    expect(workflow).toContain("building unsigned release artifacts");
    expect(workflow).toContain(
      "Publishing unsigned installer, trusted helpers, and updater metadata.",
    );
    expect(workflow).not.toContain("Unsigned Windows production releases are forbidden");
  });

  test("verifies Authenticode and post-signing hashes for every sandbox helper when signing is enabled", () => {
    expect(workflow).toContain("cowork-win-sandbox.exe");
    expect(workflow).toContain("codex-windows-sandbox-setup.exe");
    expect(workflow).toContain("codex-command-runner.exe");
    expect(workflow).toContain("Get-AuthenticodeSignature -LiteralPath $filePath");
    expect(workflow).toContain("cowork-win-sandbox.sha256.json");
    expect(workflow).toContain("Post-signing sandbox hash mismatch");
    expect(workflow).toContain("- name: Verify Windows release artifacts");
    expect(builderConfig).toContain("afterPack: scripts/afterPack.cjs");
    expect(builderConfig).toContain("forceCodeSigning: false");
    expect(builderConfig).toContain("verifyUpdateCodeSignature: true");
  });

  test("builds ARM64 release artifacts without native ARM smoke gating", () => {
    expect(workflow).toContain("pattern: desktop-release-*");
    expect(workflow).toContain("artifact_name: desktop-release-windows-arm64");
    expect(workflow).toContain("updater_metadata_name: latest-arm64.yml");
    expect(workflow).not.toContain("desktop-smoke-windows-arm64-unpacked");
    expect(workflow).not.toContain("Smoke Windows ARM64 Desktop");
    expect(workflow).not.toContain("runs-on: windows-11-arm");
  });

  test("publishes release assets after package success without an ARM64 smoke gate", () => {
    expect(workflow).toMatch(
      /publish:[\s\S]*?needs:[\s\S]*?- package[\s\S]*?if: \$\{\{ always\(\) && startsWith\(github\.ref, 'refs\/tags\/'\) && needs\.package\.result == 'success' \}\}/,
    );
    expect(workflow).not.toContain("smoke-windows-arm64");
    expect(workflow).not.toContain("needs.smoke-windows-arm64");
    expect(workflow).toContain("- name: Collect release asset list");
    expect(workflow).toContain("files: ${{ steps.collect-release-assets.outputs.files }}");
  });
});
