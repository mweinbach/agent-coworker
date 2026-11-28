import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const workflowPath = new URL("../.github/workflows/ci.yml", import.meta.url);
const rootPackagePath = new URL("../package.json", import.meta.url);
const bunVersionPath = new URL("../.bun-version", import.meta.url);
const setupBunActionPath = new URL("../.github/actions/setup-bun/action.yml", import.meta.url);
const workflow = readFileSync(workflowPath, "utf8");
const rootPackage = JSON.parse(readFileSync(rootPackagePath, "utf8")) as {
  scripts?: Record<string, string>;
};
const setupBunAction = readFileSync(setupBunActionPath, "utf8");
const bunVersion = readFileSync(bunVersionPath, "utf8").trim();
const { jobs } = Bun.YAML.parse(workflow) as {
  jobs: Record<
    string,
    {
      steps: Array<{
        uses?: string;
        run?: string;
        if?: string;
        "continue-on-error"?: boolean;
        with?: Record<string, string>;
      }>;
    }
  >;
};

describe("main CI workflow", () => {
  test("pins Bun version via .bun-version file", () => {
    expect(workflow).toContain("uses: ./.github/actions/setup-bun");
    expect(setupBunAction).toContain("- name: Setup Bun");
    // The third-party setup action must stay pinned to an immutable commit SHA
    // (not a mutable tag) to prevent supply-chain compromise via retagging.
    expect(setupBunAction).toMatch(/uses: oven-sh\/setup-bun@[0-9a-f]{40}\b/);
    expect(setupBunAction).not.toMatch(/uses: oven-sh\/setup-bun@v\d/);
    expect(setupBunAction).toContain('bun-version-file: ".bun-version"');
    expect(bunVersion).toBe("canary");
  });

  test("caches dependencies", () => {
    expect(workflow).toContain("cache-scope: mobile");
    expect(setupBunAction).toContain("save-cache:");
    expect(setupBunAction).toContain("uses: actions/cache@v4");
    expect(setupBunAction).toContain("uses: actions/cache/restore@v4");
    expect(setupBunAction).toContain("if: ${{ inputs.save-cache == 'true' }}");
    expect(setupBunAction).toContain("if: ${{ inputs.save-cache != 'true' }}");
    expect(setupBunAction).toContain("~/.bun/install/cache");
    expect(setupBunAction).not.toContain("~/.cache/electron");
    expect(setupBunAction).not.toContain("apps/desktop/package.json");
    expect(setupBunAction).toContain("bun install --frozen-lockfile");
    expect(setupBunAction).not.toContain("node_modules");
    expect(workflow).toContain("run: bun install --cwd apps/mobile --frozen-lockfile");
  });

  test("installs locked mobile SDK dependencies before the full test suite", () => {
    const steps = jobs.test.steps;
    const setupIndex = steps.findIndex((step) => step.uses === "./.github/actions/setup-bun");
    const installIndex = steps.findIndex(
      (step) => step.run === "bun install --cwd apps/mobile --frozen-lockfile",
    );
    const testIndex = steps.findIndex((step) => step.run === "bun run test");

    expect(setupIndex).toBeGreaterThanOrEqual(0);
    expect(installIndex).toBeGreaterThan(setupIndex);
    expect(testIndex).toBeGreaterThan(installIndex);
    expect(steps[installIndex].if).toBeUndefined();
    expect(steps[installIndex]["continue-on-error"]).toBeUndefined();
  });

  test("shares the mobile dependency cache and lock inputs with the Mobile job", () => {
    const testSetup = jobs.test.steps.find((step) => step.uses === "./.github/actions/setup-bun");
    const mobileSetup = jobs.mobile.steps.find(
      (step) => step.uses === "./.github/actions/setup-bun",
    );
    const inputs = testSetup?.with;
    const cachePaths = inputs?.["cache-dependency-path"]?.trim().split(/\s+/) ?? [];

    expect(inputs?.["cache-scope"]).toBe("mobile");
    expect(inputs).toEqual(mobileSetup?.with);
    expect(cachePaths).toContain("bun.lock");
    expect(cachePaths).toContain("apps/mobile/bun.lock");
    expect(cachePaths).toContain("apps/mobile/package.json");
  });

  test("keeps the core reliability guardrails", () => {
    expect(rootPackage.scripts?.test).toBe("bun scripts/run_tests.ts");
    expect(rootPackage.scripts?.["test:stable"]).toBeUndefined();
    expect(workflow).toContain("- name: Docs consistency check");
    expect(workflow).toContain("run: bun run docs:check");
    expect(workflow).toContain("- name: Typecheck");
    expect(workflow).toContain("run: bun run typecheck");
    expect(workflow).toContain("- name: Unit tests");
    // Keep the workflow on the project runner. Windows/Linux retain the direct
    // single-process serial run; the runner adds per-file isolation on Darwin
    // because Bun canary otherwise leaks mock.module registrations between
    // unrelated desktop files. Do not add parallelism or sharding without
    // re-validating the complete suite.
    expect(workflow).toMatch(/- name: Unit tests\s*\n\s*run: bun run test\n/);
    expect(workflow).not.toContain("--max-concurrency");
    expect(workflow).not.toContain("run: bun run test:stable");
  });

  test("shares the root compiler without coupling raw-loop or mobile commands", () => {
    const harnessPackage = JSON.parse(
      readFileSync(new URL("../packages/harness/package.json", import.meta.url), "utf8"),
    );
    expect(rootPackage.scripts?.typecheck).toBe("bunx tsc --noEmit");
    expect(rootPackage.scripts?.start).toBe(
      "cargo build --quiet -p cowork-server --bin cowork-server && cargo run --quiet -p cowork-desktop --bin cowork-desktop --",
    );
    expect(rootPackage.scripts?.["app:mobile:typecheck"]).toBe(
      "cd apps/mobile && bun run typecheck",
    );
    expect(rootPackage.scripts?.["harness:run"]).toBe(
      "bun packages/harness/src/run_raw_agent_loops.ts",
    );
    expect(harnessPackage.scripts).toBeUndefined();
    expect(harnessPackage.devDependencies.typescript).toBeUndefined();
  });

  test("runs Windows path and server smoke coverage", () => {
    const windowsSmokeJob = workflow.match(/windows-smoke:[\s\S]*?\n {2}macos-smoke:/)?.[0] ?? "";

    expect(workflow).toContain("windows-smoke:");
    expect(workflow).toContain("runner: windows-latest");
    expect(workflow).toContain("runner: windows-11-arm");
    expect(workflow).toContain("runs-on: ${{ matrix.runner }}");
    expect(windowsSmokeJob).toMatch(
      /- name: Setup dependencies[\s\S]*?uses: \.\/\.github\/actions\/setup-bun[\s\S]*?with:[\s\S]*?cache-scope: windows-smoke-\$\{\{ matrix\.arch \}\}[\s\S]*?save-cache: "false"/,
    );
    expect(workflow).toContain("- name: Windows MXC sandbox enforcement");
    expect(windowsSmokeJob).toContain('MXC_TELEMETRY_COMPONENT_PATH: ""');
    expect(windowsSmokeJob).toContain(
      "cargo test -p cowork-sandbox --test windows_mxc_live -- --nocapture",
    );
    expect(windowsSmokeJob).toContain(
      "cargo test -p cowork-tools --test bash_approval_parity_tests windows_bash_uses_host_sandbox -- --exact",
    );
    expect(workflow).not.toContain("cowork-win-sandbox");
    expect(workflow).not.toContain("COWORK_WIN_SANDBOX_HELPER");
    expect(workflow).not.toContain("test/platform/sandbox");
    expect(workflow).toContain("test/build-desktop-resources.test.ts");
    expect(workflow).toContain("- name: Windows path and server smoke tests");
    expect(workflow).toContain("test/rust-server.http-and-rpc.integration.test.ts");
    expect(workflow).toContain("test/rust-server.mobile-h3.integration.test.ts");
    expect(workflow).toContain("test/rust-server.jsonrpc-turns-and-tools.integration.test.ts");
    expect(workflow).toContain("test/rust-server.extensions-and-office.integration.test.ts");
  });

  test("runs native macOS sandbox and runtime coverage on Apple Silicon", () => {
    expect(workflow).toContain("macos-smoke:");
    expect(workflow).toContain("name: macOS ARM64 smoke");
    expect(workflow).toContain("runs-on: macos-15");
    expect(workflow).toContain("- name: macOS runtime and resource smoke");
    expect(workflow).toContain("cargo test -p cowork-sandbox -p cowork-env -p cowork-js-vm");
    expect(workflow).toContain("test/cli-entrypoint.test.ts");
    expect(workflow).toContain("test/build-desktop-resources.test.ts");
    expect(workflow).not.toContain("electron-quality:");
    expect(workflow).not.toContain("apps/desktop/");
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
    expect(workflow).toContain("run: cargo test -p cowork-mcp --test remote_grep_smoke");
    // The job must exercise a live remote server, not re-run the offline unit suite.
    const remoteSmoke = readFileSync(
      new URL("../crates/cowork-mcp/tests/remote_grep_smoke.rs", import.meta.url),
      "utf8",
    );
    expect(remoteSmoke).toContain("RUN_REMOTE_MCP_TESTS");
    expect(remoteSmoke).toContain("https://mcp.grep.app");
  });

  test("skips remote MCP smoke on fork pull requests", () => {
    expect(workflow).toContain(
      "if: github.event_name != 'pull_request' || !github.event.pull_request.head.repo.fork",
    );
  });

  test("runs Rust fmt, clippy, and workspace tests in dedicated jobs", () => {
    const stepRuns = (job: string) => jobs[job]?.steps.map((step) => step.run ?? "") ?? [];
    expect(stepRuns("rust-lint")).toContain("cargo fmt --all -- --check");
    expect(stepRuns("rust-lint")).toContain(
      "cargo clippy --workspace --all-targets -- -D warnings",
    );
    // Clippy already type-checks every target.
    expect(workflow).not.toContain("cargo check --workspace --all-targets");
    expect(stepRuns("rust-test")).toContain("cargo test --workspace --no-fail-fast");
    // A Rust failure must not hide JavaScript lint or test results (and vice versa).
    for (const job of ["lint", "test"]) {
      expect(stepRuns(job).some((run) => run.startsWith("cargo "))).toBe(false);
    }
    expect(jobs["rust-lint"]?.steps.find((step) => step.run?.startsWith("cargo clippy"))?.if).toBe(
      "${{ !cancelled() }}",
    );
  });

  test("runs Linux Rust and black-box server suites under real bubblewrap enforcement", () => {
    for (const job of ["rust-test", "test", "linux-sandbox"]) {
      expect(
        jobs[job]?.steps.some((step) => step.uses === "./.github/actions/setup-linux-sandbox"),
        job,
      ).toBe(true);
    }
    const sandboxAction = readFileSync(
      new URL("../.github/actions/setup-linux-sandbox/action.yml", import.meta.url),
      "utf8",
    );
    expect(sandboxAction).toContain("bubblewrap");
    expect(sandboxAction).toContain("kernel.apparmor_restrict_unprivileged_userns=0");
  });

  test("installs Linux desktop linking and software Vulkan deps before cowork-desktop tests", () => {
    for (const job of ["rust-test", "test"]) {
      expect(
        jobs[job]?.steps.some((step) => step.uses === "./.github/actions/setup-linux-desktop"),
        job,
      ).toBe(true);
    }
    const desktopAction = readFileSync(
      new URL("../.github/actions/setup-linux-desktop/action.yml", import.meta.url),
      "utf8",
    );
    expect(desktopAction).toContain("libxkbcommon-dev");
    expect(desktopAction).toContain("mesa-vulkan-drivers");
    for (const relWorkflow of [
      ".github/workflows/cowork-server-release.yml",
      ".github/workflows/desktop-rune-release.yml",
    ]) {
      const release = Bun.YAML.parse(
        readFileSync(new URL(`../${relWorkflow}`, import.meta.url), "utf8"),
      ) as {
        jobs: Record<string, { steps: Array<{ uses?: string }> }>;
      };
      expect(
        release.jobs.validate?.steps.some(
          (step) => step.uses === "./.github/actions/setup-linux-desktop",
        ),
        relWorkflow,
      ).toBe(true);
    }
  });

  test("release validate jobs mirror CI sandbox setup, Cargo debuginfo bounds, and disk cleanup", () => {
    // Release workflows only run on tags, so a drift from ci.yml stays hidden
    // until a release fails in `validate`.
    const ciWorkflow = Bun.YAML.parse(workflow) as {
      env: Record<string, string>;
      jobs: Record<
        string,
        { env?: Record<string, string>; steps: Array<{ name?: string; run?: string }> }
      >;
    };
    const ciDiskCleanup = ciWorkflow.jobs["rust-test"]?.steps.find(
      (step) => step.name === "Free runner disk space",
    )?.run;
    expect(ciDiskCleanup).toBeDefined();
    const expectedEnv = { ...ciWorkflow.env, ...ciWorkflow.jobs["rust-test"]?.env };
    expect(expectedEnv).toMatchObject({
      CARGO_PROFILE_DEV_DEBUG: "line-tables-only",
      CARGO_PROFILE_DEV_PACKAGE____DEBUG: "false",
      CARGO_INCREMENTAL: "0",
    });

    for (const relWorkflow of [".github/workflows/cowork-server-release.yml"]) {
      const release = Bun.YAML.parse(
        readFileSync(new URL(`../${relWorkflow}`, import.meta.url), "utf8"),
      ) as {
        env?: Record<string, string>;
        jobs: Record<
          string,
          {
            env?: Record<string, string>;
            steps: Array<{ name?: string; uses?: string; run?: string }>;
          }
        >;
      };
      const validate = release.jobs.validate;
      expect(validate, relWorkflow).toBeDefined();
      expect({ ...release.env, ...validate?.env }, relWorkflow).toMatchObject(expectedEnv);
      const steps = validate?.steps ?? [];
      const indexOf = (predicate: (step: (typeof steps)[number]) => boolean) =>
        steps.findIndex(predicate);
      const cleanup = indexOf((step) => step.name === "Free runner disk space");
      const sandbox = indexOf((step) => step.uses === "./.github/actions/setup-linux-sandbox");
      const cargoTest = indexOf((step) => step.run?.startsWith("cargo test") ?? false);
      const bunTest = indexOf((step) => step.run === "bun run test");
      expect(steps[cleanup]?.run, relWorkflow).toBe(ciDiskCleanup);
      expect(cleanup, relWorkflow).toBeGreaterThanOrEqual(0);
      expect(sandbox, relWorkflow).toBeGreaterThanOrEqual(0);
      expect(cargoTest, relWorkflow).toBeGreaterThan(Math.max(cleanup, sandbox));
      expect(bunTest, relWorkflow).toBeGreaterThan(sandbox);
    }
  });

  test("installs mobile dependencies before the dead-export check", () => {
    const steps = jobs.lint.steps;
    const installIndex = steps.findIndex(
      (step) => step.run === "bun install --cwd apps/mobile --frozen-lockfile",
    );
    const knipIndex = steps.findIndex((step) => step.run === "bun run knip");
    expect(installIndex).toBeGreaterThanOrEqual(0);
    expect(knipIndex).toBeGreaterThan(installIndex);
  });

  test("pins the Rust toolchain and uses a portable, pruning Cargo cache", () => {
    const setupRustAction = readFileSync(
      new URL("../.github/actions/setup-rust-cache/action.yml", import.meta.url),
      "utf8",
    );
    const toolchain = readFileSync(new URL("../rust-toolchain.toml", import.meta.url), "utf8");
    expect(toolchain).toMatch(/channel = "\d+\.\d+\.\d+"/);
    expect(toolchain).toContain('"clippy"');
    expect(toolchain).toContain('"rustfmt"');
    // Third-party actions stay pinned to immutable commit SHAs.
    expect(setupRustAction).toMatch(/uses: Swatinem\/rust-cache@[0-9a-f]{40}\b/);
    expect(setupRustAction).toContain("rustup toolchain install");
    expect(setupRustAction).not.toContain("crates/cowork-win-sandbox");
    // macOS runners ship bash 3.2, which has no globstar.
    expect(setupRustAction).not.toContain("globstar");
  });

  test("references only existing test files across CI and release workflows", () => {
    const repoRoot = path.resolve(import.meta.dir, "..");
    const workflowFiles = [
      ".github/workflows/ci.yml",
      ".github/workflows/cowork-server-release.yml",
      ".github/workflows/desktop-rune-release.yml",
    ];
    for (const relWorkflow of workflowFiles) {
      const content = readFileSync(path.join(repoRoot, relWorkflow), "utf8");
      const matches = content.matchAll(
        /\b((?:test|apps\/desktop\/test)\/[A-Za-z0-9._/-]+\.test\.tsx?)\b/g,
      );
      for (const match of matches) {
        const testRel = match[1]!;
        expect(
          existsSync(path.join(repoRoot, testRel)),
          `${relWorkflow} references missing test file ${testRel}`,
        ).toBe(true);
      }
    }
  });
});
