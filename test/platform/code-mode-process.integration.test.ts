import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { codeModeCgroupParent, spawnCodeModeProcess } from "../../src/platform/codeModeProcess";
import { hostPlatform } from "../../src/platform/host";
import { isAlive, run } from "../../src/platform/proc";
import { scratchRoots } from "../../src/platform/sandbox";
import { createCodeModeTool } from "../../src/runtime/codeMode";

function preflightDelegatedRoot() {
  expect(hostPlatform()).toBe("linux");
  const configuredRoot = process.env.COWORK_CODE_MODE_CGROUP_ROOT;
  if (!configuredRoot) {
    throw new Error(
      "COWORK_CODE_MODE_CGROUP_ROOT must name a predelegated empty root; the test does not provision it",
    );
  }
  const root = fs.realpathSync(codeModeCgroupParent("", configuredRoot));
  expect(fs.statfsSync(root).type).toBe(0x63677270);
  fs.accessSync(root, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
  const controllers = fs
    .readFileSync(path.join(root, "cgroup.subtree_control"), "utf8")
    .trim()
    .split(/\s+/);
  expect(controllers).toContain("memory");
  expect(controllers).toContain("pids");
  const childGroups = () =>
    fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  expect(fs.readFileSync(path.join(root, "cgroup.procs"), "utf8").trim()).toBe("");
  expect(childGroups()).toHaveLength(0);
  return { root, controllers, childGroups };
}

/**
 * Explicit native verification, never substitutes a fake executor.
 * Requires Linux, usable bwrap/system Python, and COWORK_CODE_MODE_CGROUP_ROOT
 * pointing to an empty, writable cgroup-v2 resource root with memory+pids
 * already enabled in cgroup.subtree_control. CI/operator provisioning owns
 * delegation; this test NEVER enables controllers or changes privileges.
 *
 * RUN_CODE_MODE_PROCESS_INTEGRATION=1 \
 * COWORK_CODE_MODE_CGROUP_ROOT=/sys/fs/cgroup/<predelegated-empty-root> \
 * bun run test -- test/platform/code-mode-process.integration.test.ts
 */
test.skipIf(process.env.RUN_CODE_MODE_PROCESS_INTEGRATION !== "1")(
  "production executor enforces Linux memory limits, preserves its parent and removes every cgroup",
  async () => {
    const { root, controllers, childGroups } = preflightDelegatedRoot();

    const parentPid = process.pid;
    const maxMemoryBytes = 128 * 1024 * 1024;
    type Evidence = {
      pid: number;
      group?: string;
      oomKills: number;
      disposed: boolean;
    };
    const executions: Evidence[] = [];
    let current!: Evidence;
    const catalogCalls: unknown[] = [];
    const tool = createCodeModeTool(
      {
        catalog: {
          search: () => [],
          call: (input) => {
            // Read the launcher's host-visible membership before it dies. Its
            // cgroup contains bwrap and the Bun process in the private PID ns.
            current.group = codeModeCgroupParent(
              fs.readFileSync(`/proc/${current.pid}/cgroup`, "utf8"),
            );
            expect(path.dirname(current.group)).toBe(root);
            expect(path.basename(current.group)).toStartWith("cowork-code-mode-");
            expect(fs.readFileSync(path.join(current.group, "memory.max"), "utf8").trim()).toBe(
              String(maxMemoryBytes),
            );
            expect(
              fs.readFileSync(path.join(current.group, "memory.swap.max"), "utf8").trim(),
            ).toBe("0");
            catalogCalls.push(input);
            return { answer: 21, received: input.arguments };
          },
        },
        limits: { timeoutMs: 3000, maxMemoryBytes },
      },
      {
        spawnProcess(input) {
          // This wrapper adds evidence collection, never changes enforcement.
          const executor = spawnCodeModeProcess(input);
          const evidence: Evidence = {
            pid: executor.child.pid,
            oomKills: 0,
            disposed: false,
          };
          current = evidence;
          executions.push(evidence);
          return {
            child: executor.child,
            async dispose() {
              try {
                if (evidence.group) {
                  const events = fs.readFileSync(
                    path.join(evidence.group, "memory.events"),
                    "utf8",
                  );
                  evidence.oomKills = Number(/^oom_kill (\d+)$/m.exec(events)?.[1] ?? 0);
                }
              } finally {
                await executor.dispose();
                evidence.disposed = true;
              }
            },
          };
        },
      },
    );
    const assertCleaned = (evidence: Evidence) => {
      expect(evidence.group).toBeDefined();
      expect(evidence.disposed).toBe(true);
      expect(isAlive(evidence.pid)).toBe(false);
      expect(fs.existsSync(evidence.group!)).toBe(false);
      expect(childGroups()).toHaveLength(0);
      expect(process.pid).toBe(parentPid);
      expect(isAlive(parentPid)).toBe(true);
    };
    expect(
      await tool.execute({
        code: `
          const result = await tools.call("fixture.lookup", {id: 7});
          return {
            computed: result.answer * 2, received: result.received,
            ambient: [typeof process, typeof Bun, typeof fetch, typeof require]
          };
        `,
      }),
    ).toEqual({ computed: 42, received: { id: 7 }, ambient: Array(4).fill("undefined") });
    expect(catalogCalls).toEqual([{ name: "fixture.lookup", arguments: { id: 7 } }]);
    expect(executions[0].oomKills).toBe(0);
    assertCleaned(executions[0]);

    // Touch and retain native backing stores, not merely JSC-managed objects.
    // A timeout, VM allocation exception or arbitrary child crash does NOT pass:
    // the kernel must record an actual cgroup OOM kill before group removal.
    await expect(
      tool.execute({
        code: 'await tools.call("ready", {}); const held=[]; for (;;) held.push(new Uint8Array(8*1024*1024).fill(1));',
      }),
    ).rejects.toThrow("process exited without a result");
    expect(executions[1].oomKills).toBeGreaterThan(0);
    assertCleaned(executions[1]);

    // A failed child must not poison later executions/the harness.
    expect(
      await tool.execute({
        code: 'return (await tools.call("fixture.lookup", {id: 8})).answer + 1;',
      }),
    ).toBe(22);
    expect(executions).toHaveLength(3);
    expect(new Set(executions.map((execution) => execution.group)).size).toBe(3);
    expect(executions[2].oomKills).toBe(0);
    assertCleaned(executions[2]);
    expect(fs.readFileSync(path.join(root, "cgroup.procs"), "utf8").trim()).toBe("");
    expect(
      fs.readFileSync(path.join(root, "cgroup.subtree_control"), "utf8").trim().split(/\s+/),
    ).toEqual(controllers);
  },
);

test.skipIf(process.env.RUN_CODE_MODE_PROCESS_INTEGRATION !== "1")(
  "compiled Bun executable reenters its own runtime with production cgroups from a different cwd",
  async () => {
    const { root, controllers, childGroups } = preflightDelegatedRoot();
    const temporary = fs.mkdtempSync(
      path.join(scratchRoots()[0], "cowork-code-mode-compiled-native-"),
    );
    const sourceDirectory = path.join(temporary, "source");
    const launchDirectory = path.join(temporary, "different-cwd");
    const entry = path.join(sourceDirectory, "entry.ts");
    const executable = path.join(temporary, "compiled-code-mode");
    const actualModule = fileURLToPath(new URL("../../src/runtime/codeMode.ts", import.meta.url));
    try {
      fs.mkdirSync(sourceDirectory);
      fs.mkdirSync(launchDirectory);
      // Import the actual factory. There is intentionally no second argument,
      // test helper, injected spawner, or alternate executor in this program.
      fs.writeFileSync(
        entry,
        `
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createCodeModeTool } from ${JSON.stringify(actualModule)};

const root = ${JSON.stringify(root)};
const maxMemoryBytes = 128 * 1024 * 1024;
const calls = [];
let group;
let memberPids = [];
const tool = createCodeModeTool({
  catalog: {
    search: () => [],
    call: (input) => {
      const groups = fs.readdirSync(root, {withFileTypes: true}).filter(entry => entry.isDirectory());
      assert.equal(groups.length, 1);
      assert.ok(groups[0].name.startsWith("cowork-code-mode-"));
      group = path.join(root, groups[0].name);
      assert.equal(fs.readFileSync(path.join(group, "memory.max"), "utf8").trim(), String(maxMemoryBytes));
      assert.equal(fs.readFileSync(path.join(group, "memory.swap.max"), "utf8").trim(), "0");
      memberPids = fs.readFileSync(path.join(group, "cgroup.procs"), "utf8")
        .trim().split(/\\s+/).filter(Boolean).map(Number);
      assert.ok(memberPids.length > 0);
      assert.ok(memberPids.every(pid => Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid));
      calls.push(input);
      return {answer: 21, received: input.arguments};
    },
  },
  limits: {timeoutMs: 3000, maxMemoryBytes},
});
const result = await tool.execute({
  code: 'const value = await tools.call("fixture.lookup", {id: 19}); return {computed: value.answer * 2, received: value.received};',
});
assert.ok(group);
assert.equal(fs.existsSync(group), false);
assert.equal(fs.readdirSync(root, {withFileTypes: true}).filter(entry => entry.isDirectory()).length, 0);
console.log(JSON.stringify({result, calls, group, memberPids, executable: process.execPath, cwd: process.cwd()}));
`,
      );
      const compiled = await run(
        process.execPath,
        [
          "--no-env-file",
          "--config=/dev/null",
          "build",
          "--compile",
          entry,
          "--outfile",
          executable,
        ],
        {
          cwd: sourceDirectory,
          env: {
            PATH: "/usr/bin:/bin",
            HOME: "/nonexistent",
            TMPDIR: temporary,
            BUN_BE_BUN: "1",
          },
          timeoutMs: 20_000,
          killSignal: "SIGKILL",
          maxBuffer: 64 * 1024,
        },
      );
      if (compiled.exitCode !== 0 || compiled.errorCode) {
        throw new Error(
          `native fixture compilation failed (${compiled.errorCode ?? compiled.exitCode}): ${compiled.stderr}`,
        );
      }
      // The generated entry must not be available to the compiled application.
      fs.unlinkSync(entry);
      fs.rmdirSync(sourceDirectory);
      const executed = await run(executable, [], {
        cwd: launchDirectory,
        env: {
          PATH: "/usr/bin:/bin",
          HOME: "/nonexistent",
          TMPDIR: temporary,
          COWORK_CODE_MODE_CGROUP_ROOT: root,
          // No BUN_BE_BUN here: run the bundled application. Its production
          // executor must set that flag itself when reentering this binary.
        },
        timeoutMs: 10_000,
        killSignal: "SIGKILL",
        maxBuffer: 64 * 1024,
      });
      // Assert production cleanup even when the compiled program reports an
      // error. Do not delete arbitrary control directories to hide a leak.
      expect(childGroups()).toHaveLength(0);
      if (executed.exitCode !== 0 || executed.errorCode) {
        throw new Error(
          `compiled production executor failed (${executed.errorCode ?? executed.exitCode}): ${executed.stderr}`,
        );
      }
      const evidence = JSON.parse(executed.stdout);
      expect(evidence.result).toEqual({ computed: 42, received: { id: 19 } });
      expect(evidence.calls).toEqual([{ name: "fixture.lookup", arguments: { id: 19 } }]);
      expect(evidence.executable).toBe(executable);
      expect(evidence.cwd).toBe(launchDirectory);
      expect(path.dirname(evidence.group)).toBe(root);
      expect(path.basename(evidence.group)).toStartWith("cowork-code-mode-");
      expect(fs.existsSync(evidence.group)).toBe(false);
      expect(evidence.memberPids.length).toBeGreaterThan(0);
      for (const pid of evidence.memberPids) {
        expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
        expect(isAlive(pid)).toBe(false);
      }
      expect(fs.readFileSync(path.join(root, "cgroup.procs"), "utf8").trim()).toBe("");
      expect(
        fs.readFileSync(path.join(root, "cgroup.subtree_control"), "utf8").trim().split(/\s+/),
      ).toEqual(controllers);
    } finally {
      // Only this test's freshly created compilation/cwd tree is removed.
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  },
  // Two separately bounded subprocess operations: 20s build + 10s execution,
  // with 5s for assertions/cleanup. This is not a suite-wide timeout increase.
  35_000,
);
