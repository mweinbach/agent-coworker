import { expect, test } from "bun:test";

import { officeWasmQualification } from "../scripts/officeWasmQualification";
import { positiveLinuxReadView } from "../scripts/officeWasmQualification/linuxReadView";
import { validatePng } from "../scripts/officeWasmQualification/png";
import {
  parsePrintedSandboxCommand,
  sandboxPrintCommandArgs,
} from "../scripts/officeWasmQualification/rustSandbox";

const root = "/home/runner/temp/office-run";
const assets = "/home/runner/temp/office-assets";
const server = "/home/runner/work/agent-coworker/target/debug/cowork-server";
const executables = ["/home/runner/node/bin/node", "/opt/poppler/bin/pdfinfo"];
const innerCommand = [executables[0], "/synthetic/child.mjs", "probe"];

// Shape of `cowork-server __sandbox-exec --print-command` on Linux (crates/cowork-sandbox/src/bwrap.rs).
const linuxPrintCommandLine = JSON.stringify({
  sandbox: "linux-bwrap",
  file: "/usr/bin/bwrap",
  args: [
    "--new-session",
    "--die-with-parent",
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--bind",
    root,
    root,
    "--bind",
    "/tmp",
    "/tmp",
    "--ro-bind",
    `${root}/.git`,
    `${root}/.git`,
    "--tmpfs",
    "/home/runner/.ssh",
    "--remount-ro",
    "/home/runner/.ssh",
    "--tmpfs",
    `${root}/.cowork/auth`,
    "--remount-ro",
    `${root}/.cowork/auth`,
    "--ro-bind",
    "/dev/null",
    "/home/runner/.aws",
    "--unshare-user",
    "--unshare-pid",
    "--unshare-ipc",
    "--proc",
    "/proc",
    "--unshare-net",
    "--chdir",
    root,
    "--",
    server,
    "__sandbox-exec",
    "--linux-seccomp",
    "--deny-network",
    "--",
    ...innerCommand,
  ],
  cwd: root,
  env: {
    PATH: "/usr/bin:/bin",
    COWORK_SANDBOX: "linux-bwrap",
    COWORK_SANDBOX_NETWORK_DISABLED: "1",
  },
  sandboxEnv: { COWORK_SANDBOX: "linux-bwrap", COWORK_SANDBOX_NETWORK_DISABLED: "1" },
  enforcement: { filesystem: true, network: true, process: true, integrity: true },
  unsandboxed: false,
});

const fakeFilesystem = {
  exists: () => true,
  realpath: (file: string) => file,
  isFile: (file: string) => file === server || executables.includes(file),
};

function mountTriples(args: string[]): string[][] {
  const mounts: string[][] = [];
  const end = args.indexOf("--");
  for (let i = 0; i < end; i++) {
    if (["--ro-bind", "--bind", "--dev-bind"].includes(args[i])) {
      mounts.push(args.slice(i, i + 3));
      i += 2;
    }
  }
  return mounts;
}

test("Rust sandbox print-command request is a fail-closed, network-less workspace-write launch", () => {
  expect(
    sandboxPrintCommandArgs({ root, file: innerCommand[0], args: innerCommand.slice(1) }),
  ).toEqual([
    "__sandbox-exec",
    "--print-command",
    "--cwd",
    root,
    "--mode",
    "workspace-write",
    "--writable-root",
    root,
    "--no-network",
    "--require-backend",
    "--",
    ...innerCommand,
  ]);
  const parsed = parsePrintedSandboxCommand(`${linuxPrintCommandLine}\n`);
  expect(parsed.sandbox).toBe("linux-bwrap");
  expect(parsed.sandboxEnv).toEqual({
    COWORK_SANDBOX: "linux-bwrap",
    COWORK_SANDBOX_NETWORK_DISABLED: "1",
  });
  expect(() => parsePrintedSandboxCommand(`${linuxPrintCommandLine}\n{}`)).toThrow(
    "exactly one JSON line",
  );
  expect(() =>
    parsePrintedSandboxCommand(
      JSON.stringify({ ...JSON.parse(linuxPrintCommandLine), sandbox: "x" }),
    ),
  ).toThrow("Invalid sandbox launch: sandbox");
  expect(() =>
    parsePrintedSandboxCommand(
      JSON.stringify({ ...JSON.parse(linuxPrintCommandLine), enforcement: { filesystem: true } }),
    ),
  ).toThrow("enforcement.network");
});

test("Linux qualification replaces whole-host reads with a positive mount view", () => {
  const original = parsePrintedSandboxCommand(linuxPrintCommandLine).args;
  const result = positiveLinuxReadView(original, { root, assets, executables }, fakeFilesystem);
  const mounts = mountTriples(result);
  expect(mounts.filter(([flag]) => flag === "--bind")).toEqual([["--bind", root, root]]);
  for (const broad of [
    "/",
    "/tmp",
    "/home",
    "/home/runner",
    "/home/runner/temp",
    "/home/runner/node",
    "/opt",
    "/etc",
    "/usr",
  ]) {
    expect(
      mounts.some(([, source, destination]) => source === broad || destination === broad),
    ).toBe(false);
  }
  // The seccomp re-exec launcher (the sandbox binary itself) must be visible inside.
  for (const file of [server, ...executables, assets])
    expect(mounts).toContainEqual(["--ro-bind", file, file]);
  // Protections inside the writable root survive; masks for unmounted host paths are dropped.
  const end = result.indexOf("--");
  const view = result.slice(0, end);
  const rootBind = view.indexOf(root, view.indexOf("--bind"));
  expect(view.lastIndexOf(`${root}/.git`)).toBeGreaterThan(rootBind);
  expect(view.lastIndexOf(`${root}/.cowork/auth`)).toBeGreaterThan(rootBind);
  expect(view).not.toContain("/home/runner/.ssh");
  expect(view).not.toContain("/home/runner/.aws");
  expect(result).toContain("--tmpfs");
  expect(result).toContain("--remount-ro");
  expect(result).toContain("--proc");
  expect(result).toContain("--dev");
  for (const flag of [
    "--unshare-net",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-user",
    "--new-session",
    "--die-with-parent",
  ]) {
    expect(result).toContain(flag);
  }
  // Includes the exact Rust seccomp launcher and inner command.
  expect(result.slice(end)).toEqual(original.slice(original.indexOf("--")));
  expect(result.slice(end)).toEqual([
    "--",
    server,
    "__sandbox-exec",
    "--linux-seccomp",
    "--deny-network",
    "--",
    ...innerCommand,
  ]);
  expect(() =>
    positiveLinuxReadView(
      ["--share-net", ...original],
      { root, assets, executables },
      fakeFilesystem,
    ),
  ).toThrow("Unexpected bubblewrap option");
  const separator = original.indexOf("--");
  const pythonLauncher = [
    ...original.slice(0, separator),
    "--",
    "/usr/bin/python3",
    "-I",
    "-S",
    "-c",
    "launcher",
    ...innerCommand,
  ];
  expect(() =>
    positiveLinuxReadView(pythonLauncher, { root, assets, executables }, fakeFilesystem),
  ).toThrow("Unexpected sandbox seccomp launcher");
});

test("Office PNG validation rejects truncated/invalid input", () => {
  expect(() => validatePng(Buffer.from("not a PNG"))).toThrow("Invalid PNG signature");
  expect(() => validatePng(Buffer.from("89504e470d0a1a0a", "hex"))).toThrow("Truncated PNG");
});

// No download or sandbox execution in ordinary tests. Setup is always an
// explicit separate command; opting in requires the same env as the CLI.
test.skipIf(process.env.OFFICE_WASM_INTEGRATION !== "1")(
  "real Office WASM offline sandbox qualification",
  async () => {
    await officeWasmQualification("qualify");
  },
  600_000,
);
