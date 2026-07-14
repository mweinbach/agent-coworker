import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const workflowPath = new URL("../.github/workflows/ci.yml", import.meta.url);
const rootPackagePath = new URL("../package.json", import.meta.url);
const setupBunActionPath = new URL("../.github/actions/setup-bun/action.yml", import.meta.url);
const workflow = readFileSync(workflowPath, "utf8");
const rootPackage = JSON.parse(readFileSync(rootPackagePath, "utf8")) as {
  scripts?: Record<string, string>;
};
const setupBunAction = readFileSync(setupBunActionPath, "utf8");

describe("main CI workflow", () => {
  test("pins Bun version via .bun-version file", () => {
    expect(workflow).toContain("uses: ./.github/actions/setup-bun");
    expect(setupBunAction).toContain("- name: Setup Bun");
    // The third-party setup action must stay pinned to an immutable commit SHA
    // (not a mutable tag) to prevent supply-chain compromise via retagging.
    expect(setupBunAction).toMatch(/uses: oven-sh\/setup-bun@[0-9a-f]{40}\b/);
    expect(setupBunAction).not.toMatch(/uses: oven-sh\/setup-bun@v\d/);
    expect(setupBunAction).toContain('bun-version-file: ".bun-version"');
  });

  test("caches dependencies", () => {
    expect(workflow).toContain("cache-scope: mobile");
    expect(setupBunAction).toContain("save-cache:");
    expect(setupBunAction).toContain("uses: actions/cache@v4");
    expect(setupBunAction).toContain("uses: actions/cache/restore@v4");
    expect(setupBunAction).toContain("if: ${{ inputs.save-cache == 'true' }}");
    expect(setupBunAction).toContain("if: ${{ inputs.save-cache != 'true' }}");
    expect(setupBunAction).toContain("~/.bun/install/cache");
    expect(setupBunAction).toContain("~/.cache/electron");
    expect(setupBunAction).toContain("~/.cache/electron-builder");
    expect(setupBunAction).toContain("bun install --frozen-lockfile");
    expect(setupBunAction).not.toContain("node_modules");
    expect(workflow).toContain("run: bun install --cwd apps/mobile --frozen-lockfile");
  });

  test("keeps the core reliability guardrails", () => {
    expect(rootPackage.scripts?.test).toBe("bun test");
    expect(rootPackage.scripts?.["test:stable"]).toBeUndefined();
    expect(workflow).toContain("- name: Docs consistency check");
    expect(workflow).toContain("run: bun run docs:check");
    expect(workflow).toContain("- name: Typecheck");
    expect(workflow).toContain("run: bun run typecheck");
    expect(workflow).toContain("- name: Unit tests");
    // Single-process serial run. Do not reintroduce `--max-concurrency 1` (a
    // no-op: it only gates test.concurrent, which this repo never uses) and do
    // not adopt `--parallel`/`--shard` without re-validating: per-file isolation
    // re-imports the module graph (measured ~+2.2s/file, slower than serial on
    // <=4-vCPU CI runners) and sharding breaks cross-file mock.module coupling.
    expect(workflow).toMatch(/- name: Unit tests\s*\n\s*run: bun test\n/);
    expect(workflow).not.toContain("--max-concurrency");
    expect(workflow).not.toContain("run: bun run test:stable");
  });

  test("runs Windows path and desktop smoke coverage", () => {
    const windowsSmokeJob = workflow.match(/windows-smoke:[\s\S]*?\n {2}macos-smoke:/)?.[0] ?? "";

    expect(workflow).toContain("windows-smoke:");
    expect(workflow).toContain("runner: windows-latest");
    expect(workflow).toContain("runner: windows-11-arm");
    expect(workflow).toContain("runs-on: ${{ matrix.runner }}");
    expect(windowsSmokeJob).toMatch(
      /- name: Setup dependencies[\s\S]*?uses: \.\/\.github\/actions\/setup-bun[\s\S]*?with:[\s\S]*?cache-scope: windows-smoke-\$\{\{ matrix\.arch \}\}[\s\S]*?save-cache: "false"/,
    );
    expect(workflow).toContain("- name: Windows sandbox helper enforcement");
    expect(workflow).toContain(
      "cargo build --release --bins --manifest-path crates\\cowork-win-sandbox\\Cargo.toml",
    );
    expect(workflow).toContain(
      '$binaryRoot = Join-Path (Get-Location) "crates\\cowork-win-sandbox\\target\\release"',
    );
    expect(workflow).toContain('$helperPath = Join-Path $binaryRoot "cowork-win-sandbox.exe"');
    expect(workflow).toContain("$env:COWORK_WIN_SANDBOX_HELPER = $helperPath");
    expect(workflow).toContain("COWORK_WIN_SANDBOX_HELPER_SHA256");
    expect(workflow).toContain("COWORK_WIN_SANDBOX_SETUP_SHA256");
    expect(workflow).toContain("COWORK_WIN_SANDBOX_COMMAND_RUNNER_SHA256");
    expect(workflow).toContain('RUN_WINDOWS_SANDBOX_INTEGRATION = "1"');
    expect(workflow).toContain("$helperPath setup --sandbox-home");
    expect(workflow).not.toContain("COWORK_WIN_SANDBOX_HELPER=%CD%");
    expect(workflow).toContain("test/platform/sandbox.enforcement.integration.test.ts");
    expect(workflow).toContain("test/platform/sandbox.test.ts");
    expect(workflow).toContain("test/build-desktop-resources.test.ts");
    expect(workflow).toContain("- name: Windows path and desktop smoke tests");
    expect(workflow).toContain("apps/desktop/test/ipc-security.test.ts");
    expect(workflow).toContain("apps/desktop/test/file-preview-modal.test.tsx");
    expect(workflow).toContain("test/tools/tools.bash.test.ts");
    expect(workflow).toContain("test/session-backup.test.ts");
    expect(workflow).toContain("test/workspace-backups.test.ts");
    expect(workflow).toContain("test/h3.pairing-store.test.ts");
  });

  test("runs native macOS sandbox and runtime coverage on Apple Silicon", () => {
    expect(workflow).toContain("macos-smoke:");
    expect(workflow).toContain("name: macOS ARM64 smoke");
    expect(workflow).toContain("runs-on: macos-15");
    expect(workflow).toContain("- name: macOS sandbox and runtime enforcement");
    expect(workflow).toContain("test/platform/sandbox.enforcement.integration.test.ts");
    expect(workflow).toContain("test/coworkRuntime.test.ts");
    expect(workflow).toContain("apps/desktop/test/server-manager.test.ts");
  });

  test("runs deterministic real-Electron visual, Axe, performance, and failure-proof gates", () => {
    const qualityJob = workflow.match(/electron-quality:[\s\S]*?\n {2}windows-smoke:/)?.[0] ?? "";
    expect(qualityJob).toContain("name: Electron UI quality gates");
    expect(qualityJob).toContain(
      "mcr.microsoft.com/playwright:v1.61.1-noble@sha256:5b8f294aff9041b7191c34a4bab3ac270157a28774d4b0660e9743297b697e48",
    );
    expect(qualityJob).toContain("apt-get install --yes --no-install-recommends ffmpeg unzip");
    expect(qualityJob.indexOf("- name: Install Linux quality dependencies")).toBeLessThan(
      qualityJob.indexOf("- name: Setup dependencies"),
    );
    expect(qualityJob).toContain("xvfb-run");
    expect(qualityJob).toContain("bun run desktop:quality");
    expect(qualityJob).toContain("bun run desktop:quality:proof");
    expect(qualityJob).toContain("if: ${{ always() && !cancelled() }}");
    expect(qualityJob).toContain('OPENAI_API_KEY: ""');
    expect(qualityJob).toContain("if: failure()");
    expect(qualityJob).toContain("actions/upload-artifact@v4");
    expect(qualityJob).toContain("if-no-files-found: error");
    expect(qualityJob).toContain("apps/desktop/quality-gates/artifacts");
    expect(qualityJob).toContain("apps/desktop/quality-gates/proof-artifacts");
    expect(rootPackage.scripts?.["desktop:quality:build"]).toContain(
      "--config quality-gates/electron.vite.config.ts",
    );
  });

  test("runs the mobile install, typecheck, autolinking, and dual-platform export lane", () => {
    expect(workflow).toContain("mobile:");
    expect(workflow).toContain("name: Mobile");
    expect(workflow).toContain("timeout-minutes: 10");
    expect(workflow).toContain("- name: Install mobile dependencies");
    expect(workflow).toContain("run: bun install --cwd apps/mobile");
    expect(workflow).toContain("- name: Mobile typecheck");
    expect(workflow).toContain("run: bun run app:mobile:typecheck");
    expect(workflow).toContain("- name: Verify Expo autolinking");
    expect(workflow).toContain("expo-modules-autolinking resolve --platform apple --json");
    expect(workflow).toContain("expo-modules-autolinking resolve --platform android --json");
    expect(workflow).toContain('"packageName":"cowork-pinned-https"');
    expect(workflow).toContain("- name: Export iOS mobile bundle");
    expect(workflow).toContain(
      'bunx expo export --platform ios --output-dir "$RUNNER_TEMP/cowork-mobile-ios" --clear',
    );
    expect(workflow).toContain("- name: Export Android mobile bundle");
    expect(workflow).toContain(
      'bunx expo export --platform android --output-dir "$RUNNER_TEMP/cowork-mobile-android" --clear',
    );
    expect(workflow).not.toContain("- name: Android native build smoke");
    expect(workflow).not.toContain("./gradlew :app:assembleDebug");
    expect(workflow).not.toContain("actions/setup-java@v4");
  });

  test("keeps remote MCP smoke opt-in via secrets-backed environment", () => {
    expect(workflow).toContain('RUN_REMOTE_MCP_TESTS: "1"');
    expect(workflow).toContain("OPENCODE_API_KEY: ${{ secrets.OPENCODE_API_KEY }}");
    expect(workflow).toContain("run: bun test test/mcp.remote.grep.test.ts");
  });

  test("skips remote MCP smoke on fork pull requests", () => {
    expect(workflow).toContain(
      "if: github.event_name != 'pull_request' || !github.event.pull_request.head.repo.fork",
    );
  });
});
