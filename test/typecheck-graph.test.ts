import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scratchRoots } from "../src/platform/sandbox/policy";

const repoRoot = await realpath(fileURLToPath(new URL("..", import.meta.url)));
const compiler = path.join(repoRoot, "node_modules/typescript/bin/tsc");
const rootConfig = JSON.parse(await readFile(path.join(repoRoot, "tsconfig.json"), "utf8"));
let fixtureRoot: string;

async function runCompiler(configPath: string, ...args: string[]) {
  const child = Bun.spawn(
    [process.execPath, compiler, "--pretty", "false", "-p", configPath, ...args],
    { cwd: repoRoot, stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

async function listedFiles(configPath: string) {
  const result = await runCompiler(configPath, "--listFilesOnly", "--incremental", "false");
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  return (
    await Promise.all(
      result.stdout
        .trim()
        .split(/\r?\n/)
        .map((filename) => realpath(filename)),
    )
  ).sort();
}

beforeEach(async () => {
  fixtureRoot = await mkdtemp(path.join(scratchRoots()[0], "cowork-typecheck-"));
  await symlink(
    path.join(repoRoot, "node_modules"),
    path.join(fixtureRoot, "node_modules"),
    "junction",
  );
});

afterEach(async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
});

describe("root and harness typecheck graph", () => {
  test("preserves the resolved root/harness compiler options and isolates desktop cache", async () => {
    const result = await runCompiler(path.join(repoRoot, "tsconfig.json"), "--showConfig");
    expect(result.exitCode).toBe(0);
    const { compilerOptions } = JSON.parse(result.stdout);
    expect(compilerOptions).toEqual({
      lib: ["esnext", "dom"],
      target: "esnext",
      module: "esnext",
      moduleResolution: "bundler",
      jsx: "react-jsx",
      strict: true,
      esModuleInterop: true,
      resolveJsonModule: true,
      skipLibCheck: true,
      types: ["bun-types"],
      noEmit: true,
      incremental: true,
      tsBuildInfoFile: "./.tsbuildinfo",
    });
    const desktop = await runCompiler(
      path.join(repoRoot, "apps/desktop/tsconfig.json"),
      "--showConfig",
    );
    expect(desktop.exitCode).toBe(0);
    expect(JSON.parse(desktop.stdout).compilerOptions.tsBuildInfoFile).toBe(
      "./.tsbuildinfo-desktop",
    );
  });

  test("checks exactly the union of the former split graphs, including transitive inputs", async () => {
    const splitFiles: string[] = [];
    for (const [name, include] of [
      ["root", "src"],
      ["harness", "packages/harness/src"],
    ]) {
      const configPath = path.join(fixtureRoot, `${name}.json`);
      await writeFile(
        configPath,
        JSON.stringify({
          extends: path.join(repoRoot, "tsconfig.json"),
          include: [path.join(repoRoot, include)],
        }),
      );
      splitFiles.push(...(await listedFiles(configPath)));
    }
    const unified = await listedFiles(path.join(repoRoot, "tsconfig.json"));
    expect(unified).toEqual([...new Set(splitFiles)].sort());
    expect(unified.some((filename) => filename.startsWith(path.join(repoRoot, "apps")))).toBe(
      false,
    );
  });

  test("rejects harness-only diagnostics and accepts the repaired fixture without emitting", async () => {
    const rootSource = path.join(fixtureRoot, "src/index.ts");
    const harnessSource = path.join(fixtureRoot, "packages/harness/src/check.ts");
    const configPath = path.join(fixtureRoot, "tsconfig.json");
    await mkdir(path.dirname(rootSource), { recursive: true });
    await mkdir(path.dirname(harnessSource), { recursive: true });
    await writeFile(configPath, JSON.stringify(rootConfig));
    await writeFile(rootSource, "export const rootValue: number = 1;\n");
    await writeFile(
      harnessSource,
      [
        'import { rootValue } from "../../../src/index";',
        'export const invalidNumber: number = "harness-only";',
        "export const invalidNull: string = null;",
        "export function untypedParameter(value) { return value; }",
        "export const invalidImportUse: string = rootValue;",
        "",
      ].join("\n"),
    );

    const rejected = await runCompiler(configPath, "--incremental", "false");
    expect(rejected.exitCode).not.toBe(0);
    expect(rejected.stderr).toBe("");
    expect(rejected.stdout.match(/error TS\d+/g)).toEqual([
      "error TS2322",
      "error TS2322",
      "error TS7006",
      "error TS2322",
    ]);
    expect(rejected.stdout.replaceAll("\\", "/")).toContain("packages/harness/src/check.ts");

    await writeFile(
      harnessSource,
      [
        'import { rootValue } from "../../../src/index";',
        "export const validNumber: number = rootValue;",
        'export const validText: string = "harness";',
        "export function typedParameter(value: number) { return value; }",
        'export const bunFile: Bun.BunFile = Bun.file("example.json");',
        "export const domValue: Document = document;",
        "",
      ].join("\n"),
    );
    expect(await runCompiler(configPath, "--incremental", "false")).toEqual({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
    expect(await Bun.file(rootSource.replace(/\.ts$/, ".js")).exists()).toBe(false);
    expect(await Bun.file(harnessSource.replace(/\.ts$/, ".js")).exists()).toBe(false);
    expect(await Bun.file(path.join(fixtureRoot, ".tsbuildinfo")).exists()).toBe(false);
  });
});
