import { expect, test } from "bun:test";

import { officeWasmQualification } from "../scripts/officeWasmQualification";
import { positiveLinuxReadView } from "../scripts/officeWasmQualification/linuxReadView";
import { validatePng } from "../scripts/officeWasmQualification/png";
import { buildBwrapCommand } from "../src/platform/sandbox/bwrap";

test("Linux qualification replaces whole-host reads with a positive mount view", () => {
  const root = "/home/runner/temp/office-run";
  const assets = "/home/runner/temp/office-assets";
  const executables = ["/home/runner/node/bin/node", "/opt/poppler/bin/pdfinfo"];
  const original = buildBwrapCommand(
    { file: executables[0], args: ["/synthetic/child.mjs", "probe"] },
    { kind: "workspace-write", writableRoots: [root], network: false },
    root,
    { exists: () => true, isDirectory: () => true },
  ).args;
  const result = positiveLinuxReadView(
    original,
    { root, assets, executables },
    {
      exists: () => true,
      realpath: (file) => file,
      isFile: (file) => executables.includes(file),
    },
  );
  const mounts: string[][] = [];
  const end = result.indexOf("--");
  for (let i = 0; i < end; i++) {
    if (["--ro-bind", "--bind", "--dev-bind"].includes(result[i])) {
      mounts.push(result.slice(i, i + 3));
      i += 2;
    }
  }
  expect(mounts.filter(([flag]) => flag === "--bind")).toEqual([["--bind", root, root]]);
  for (const broad of [
    "/",
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
  for (const file of [...executables, assets])
    expect(mounts).toContainEqual(["--ro-bind", file, file]);
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
  // Includes the exact real system-Python seccomp launcher and inner command.
  expect(result.slice(end)).toEqual(original.slice(original.indexOf("--")));
  expect(() =>
    positiveLinuxReadView(["--share-net", ...original], { root, assets, executables }),
  ).toThrow("Unexpected bubblewrap option");
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
