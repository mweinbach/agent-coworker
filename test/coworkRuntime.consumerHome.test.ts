import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import type { RuntimeBootstrapLock } from "../src/coworkRuntime/bootstrapLock";
import {
  consumerLeaseTesting,
  retainRuntimeForProcess,
  runtimeConsumerHome,
} from "../src/coworkRuntime/consumerLease";
import { hostPlatform } from "../src/platform/host";
import { canonicalizeSync } from "../src/platform/paths";
import { scratchRoots } from "../src/platform/sandbox/policy";

const scratch: string[] = [];
const version = "2026-10-04";
const dirLinkType = hostPlatform() === "win32" ? "junction" : "dir";

async function scratchDir(label: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(scratchRoots()[0]!, `cowork-consumer-home-${label}-`));
  scratch.push(dir);
  return dir;
}

const managedVersion = (home: string, date = version) =>
  path.join(home, ".cowork", "runtime", date);

afterEach(async () => {
  consumerLeaseTesting.releaseAll();
  await Promise.all(scratch.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("runtimeConsumerHome", () => {
  test("recognizes a managed runtime version and ignores the leaf's existence", async () => {
    const home = await scratchDir("managed");
    await fs.mkdir(path.join(home, ".cowork", "runtime"), { recursive: true });
    const missing = managedVersion(home);
    const canonicalHome = canonicalizeSync(home);

    for (const candidate of [
      missing,
      `${missing}${path.sep}`,
      `${missing}${path.sep}..${path.sep}${version}`,
      managedVersion(home, "2026-99-99"),
      path.relative(process.cwd(), missing),
    ]) {
      expect(runtimeConsumerHome(candidate)).toBe(canonicalHome);
    }
  });

  test("attributes a symlink to the canonical managed home, not the link home", async () => {
    const root = await scratchDir("cross-home");
    const victim = path.join(root, "victim");
    const attacker = path.join(root, "attacker");
    await fs.mkdir(managedVersion(victim), { recursive: true });
    await fs.mkdir(path.join(attacker, ".cowork"), { recursive: true });
    await fs.symlink(
      path.join(victim, ".cowork", "runtime"),
      path.join(attacker, ".cowork", "runtime"),
      dirLinkType,
    );

    expect(runtimeConsumerHome(managedVersion(attacker))).toBe(canonicalizeSync(victim));
  });

  test("keeps a lexical alias home when the symlink target leaves the managed layout", async () => {
    const root = await scratchDir("alias");
    const aliasHome = path.join(root, "alias");
    const relocated = path.join(root, "relocated-runtime");
    await fs.mkdir(path.join(relocated, version), { recursive: true });
    await fs.mkdir(path.join(aliasHome, ".cowork"), { recursive: true });
    await fs.symlink(relocated, path.join(aliasHome, ".cowork", "runtime"), dirLinkType);

    expect(runtimeConsumerHome(managedVersion(aliasHome))).toBe(path.resolve(aliasHome));
    expect(runtimeConsumerHome(path.join(relocated, version))).toBeNull();
  });

  test("rejects layouts that must not own or pin a runtime", async () => {
    const home = await scratchDir("reject");
    await fs.mkdir(path.join(home, ".Cowork", "Runtime", version), { recursive: true });
    const rejected = [
      path.join(home, ".cowork", "runtimes", version),
      path.join(home, "cowork", "runtime", version),
      path.join(home, ".cowork", version),
      path.join(home, ".cowork", "runtime", "2026-10-4"),
      path.join(home, ".cowork", "runtime", `${version}-rc`),
      path.join(home, ".cowork", "runtime", version, "bin"),
      path.join(home, ".cowork", "runtime", "current"),
      "",
      "   ",
      version,
      ...(hostPlatform() === "linux" ? [path.join(home, ".Cowork", "Runtime", version)] : []),
    ];

    for (const candidate of rejected) {
      expect(runtimeConsumerHome(candidate)).toBeNull();
    }

    const external = path.join(home, "external-runtime");
    await fs.mkdir(external);
    await retainRuntimeForProcess(external, Object.freeze({}) as RuntimeBootstrapLock);
    expect((await fs.readdir(home)).sort()).toEqual([".Cowork", "external-runtime"]);
    expect(await fs.readdir(external)).toEqual([]);
  });
});
