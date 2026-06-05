import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const workflowPath = new URL("../.github/workflows/ci.yml", import.meta.url);
const setupBunActionPath = new URL("../.github/actions/setup-bun/action.yml", import.meta.url);
const stableTestRunnerPath = new URL(
  "../packages/harness/src/run_tests_stable.ts",
  import.meta.url,
);
const workflow = readFileSync(workflowPath, "utf8");
const setupBunAction = readFileSync(setupBunActionPath, "utf8");
const stableTestRunner = readFileSync(stableTestRunnerPath, "utf8");

describe("main CI workflow", () => {
  test("pins Bun version via .bun-version file", () => {
    expect(workflow).toContain("uses: ./.github/actions/setup-bun");
    expect(setupBunAction).toContain("- name: Setup Bun");
    expect(setupBunAction).toContain("uses: oven-sh/setup-bun@v2");
    expect(setupBunAction).toContain('bun-version-file: ".bun-version"');
  });

  test("caches dependencies", () => {
    expect(workflow).toContain("cache-scope: mobile");
    expect(setupBunAction).toContain("uses: actions/cache@v4");
    expect(setupBunAction).toContain("~/.bun/install/cache");
    expect(setupBunAction).toContain("~/.cache/electron");
    expect(setupBunAction).toContain("~/.cache/electron-builder");
    expect(setupBunAction).toContain("bun install --frozen-lockfile");
    expect(setupBunAction).not.toContain("node_modules");
    expect(workflow).toContain("run: bun install --cwd apps/mobile --frozen-lockfile");
  });

  test("keeps the core reliability guardrails", () => {
    expect(workflow).toContain("- name: Docs consistency check");
    expect(workflow).toContain("run: bun run docs:check");
    expect(workflow).toContain("- name: Typecheck");
    expect(workflow).toContain("run: bun run typecheck");
    expect(workflow).toContain("- name: Unit tests");
    expect(workflow).toContain("run: bun run test:stable -- --max-concurrency 1");
    expect(workflow).not.toContain("- name: Stable per-file unit tests");
  });

  test("runs Windows path and desktop smoke coverage", () => {
    expect(workflow).toContain("windows-smoke:");
    expect(workflow).toContain("runs-on: windows-latest");
    expect(workflow).toContain("- name: Windows sandbox helper enforcement");
    expect(workflow).toContain(
      "cargo build --release --manifest-path crates\\cowork-win-sandbox\\Cargo.toml",
    );
    expect(workflow).toContain(
      '$helperPath = Join-Path (Get-Location) "crates\\cowork-win-sandbox\\target\\release\\cowork-win-sandbox.exe"',
    );
    expect(workflow).toContain("COWORK_WIN_SANDBOX_HELPER=$helperPath");
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

  test("runs the mobile install, typecheck, autolinking, and export lane", () => {
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
    expect(workflow).toContain("- name: Export mobile bundle");
    expect(workflow).toContain("bunx expo export --platform ios --output-dir dist-export-ci");
    expect(workflow).not.toContain("- name: Android native build smoke");
    expect(workflow).not.toContain("./gradlew :app:assembleDebug");
    expect(workflow).not.toContain("actions/setup-java@v4");
  });

  test("stable test runner discovers TypeScript and TSX test files", () => {
    expect(stableTestRunner).toContain('"test/**/*.test.ts"');
    expect(stableTestRunner).toContain('"test/**/*.test.tsx"');
    expect(stableTestRunner).toContain('"apps/**/test/**/*.test.ts"');
    expect(stableTestRunner).toContain('"apps/**/test/**/*.test.tsx"');
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
