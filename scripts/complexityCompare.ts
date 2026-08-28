import { appendFile, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import { scratchRoots } from "../src/platform/sandbox/policy";
import { scanComplexity } from "./complexity";

type Report = Awaited<ReturnType<typeof scanComplexity>>;
type Hunk = { oldStart: number; oldCount: number; newStart: number; newCount: number };
type FileChange = { path: string; basePath?: string; hunks: Hunk[] };
type HotspotChange = Report["hotspots"][number] & {
  kind: "new" | "increased";
  previousScore?: number;
};

export function parseDiffHunks(diff: string): Hunk[] {
  return diff
    .split("\n")
    .filter((line) => line.startsWith("@@"))
    .map((line) => {
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!match) throw new Error(`Unexpected diff hunk: ${line}`);
      return {
        oldStart: Number(match[1]),
        oldCount: Number(match[2] ?? 1),
        newStart: Number(match[3]),
        newCount: Number(match[4] ?? 1),
      };
    });
}

export function mapHeadLineToBase(line: number, hunks: Hunk[]): number | undefined {
  let offset = 0;
  for (const hunk of hunks) {
    if (line < hunk.newStart) break;
    if (hunk.newCount === 0) {
      // A deletion's newStart is the preceding surviving line, including zero.
      if (line > hunk.newStart) offset += hunk.oldCount;
    } else if (line < hunk.newStart + hunk.newCount) {
      return undefined;
    } else {
      offset += hunk.oldCount - hunk.newCount;
    }
  }
  return line + offset;
}

export function compareComplexityReports(base: Report, head: Report, files: FileChange[]) {
  const previous = new Map(
    base.hotspots.map((hotspot) => [
      `${hotspot.path}\0${hotspot.line}\0${hotspot.column}`,
      hotspot.score,
    ]),
  );
  const changedFiles = new Map(files.map((file) => [file.path, file]));
  const changes: HotspotChange[] = [];
  for (const hotspot of head.hotspots) {
    const file = changedFiles.get(hotspot.path);
    const basePath = file ? file.basePath : hotspot.path;
    const baseLine = mapHeadLineToBase(hotspot.line, file?.hunks ?? []);
    const previousScore =
      basePath && baseLine !== undefined
        ? previous.get(`${basePath}\0${baseLine}\0${hotspot.column}`)
        : undefined;
    if (previousScore === undefined) changes.push({ ...hotspot, kind: "new" });
    else if (hotspot.score > previousScore) {
      changes.push({ ...hotspot, kind: "increased", previousScore });
    }
  }
  return { baseHotspots: base.hotspots.length, headHotspots: head.hotspots.length, changes };
}

type Comparison = ReturnType<typeof compareComplexityReports>;

function markdownPath(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(/[|`\r\n]/g, (character) => `&#${character.charCodeAt(0)};`);
}

export function formatComplexityComparison(comparison: Comparison): string {
  const tests = comparison.changes.filter((change) => change.test).length;
  const source = comparison.changes.length - tests;
  return [
    "## Complexity comparison",
    "",
    `Functions above 15: ${comparison.baseHotspots} → ${comparison.headHotspots}.`,
    `New or increased hotspots: ${source} source, ${tests} test.`,
    "",
    "This comparison is advisory; scan failures still fail CI. Existing unchanged or reduced scores are not flagged. " +
      "Changed declarations and moves Git cannot match are conservatively reported as new. " +
      "Review the behavior and ownership before refactoring; a justified exception needs a specific rationale in the PR.",
    "",
    "| Location | Previous | Current | Kind |",
    "| --- | ---: | ---: | --- |",
    ...comparison.changes.map(
      (change) =>
        `| ${markdownPath(change.path)}:${change.line}:${change.column} | ${change.previousScore ?? "—"} | ${change.score} | ${change.test ? "test" : "source"}, ${change.kind} |`,
    ),
    "",
  ].join("\n");
}

function annotationValue(value: string): string {
  return value
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A")
    .replaceAll(":", "%3A")
    .replaceAll(",", "%2C");
}

export function githubComplexityAnnotations(comparison: Comparison): string {
  return comparison.changes
    .map(
      (change) =>
        `::warning file=${annotationValue(change.path)},line=${change.line},col=${change.column},title=Complexity review::` +
        `${change.kind === "new" ? "New or changed function" : `Score increased from ${change.previousScore}`} ` +
        `has cognitive complexity ${change.score} (threshold 15; ${change.test ? "test" : "source"}).`,
    )
    .join("\n");
}

function git(repoRoot: string, args: string[], diff = false): string {
  const result = Bun.spawnSync(["git", "-c", "core.fsmonitor=false", ...args], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0 && !(diff && result.exitCode === 1)) {
    throw new Error(`git ${args[0]} failed: ${result.stderr.toString()}`);
  }
  return result.stdout.toString();
}

function fileChanges(
  repoRoot: string,
  baseRoot: string,
  baseCommit: string,
  head: Report,
): FileChange[] {
  const records = git(repoRoot, [
    "diff",
    "--name-status",
    "-z",
    "--find-renames",
    baseCommit,
    "--",
  ]).split("\0");
  const hotspotPaths = new Set(head.hotspots.map((hotspot) => hotspot.path));
  const changes: FileChange[] = [];
  for (let index = 0; index < records.length - 1; ) {
    const status = records[index++];
    const oldPath = records[index++];
    const newPath = status.startsWith("R") ? records[index++] : oldPath;
    if (status === "D" || !hotspotPaths.has(newPath)) continue;
    const basePath = status === "A" ? undefined : oldPath;
    const hunks = basePath
      ? parseDiffHunks(
          git(
            repoRoot,
            [
              "diff",
              "--no-index",
              "--no-ext-diff",
              "--no-textconv",
              "--no-color",
              "--unified=0",
              "--",
              path.join(baseRoot, basePath),
              path.join(repoRoot, newPath),
            ],
            true,
          ),
        )
      : [];
    changes.push({ path: newPath, basePath, hunks });
  }
  return changes;
}

export async function compareRepositoryComplexity(repoRoot: string, baseRef: string) {
  const revision = git(repoRoot, [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${baseRef}^{commit}`,
  ]).trim();
  const baseCommit = git(repoRoot, ["merge-base", "HEAD", revision]).trim();
  const headCommit = git(repoRoot, ["rev-parse", "HEAD"]).trim();
  const scratch = await realpath(await mkdtemp(path.join(scratchRoots()[0], "cowork-complexity-")));
  const baseRoot = path.join(scratch, "base");
  const hooks = path.join(scratch, "empty-hooks");
  try {
    await mkdir(hooks);
    git(repoRoot, [
      "-c",
      `core.hooksPath=${hooks}`,
      "worktree",
      "add",
      "--detach",
      "--quiet",
      baseRoot,
      baseCommit,
    ]);
    // Both revisions use the installed Biome binary, with no base dependency
    // installation. Hooks are disabled for the temporary checkout.
    const base = await scanComplexity(baseRoot);
    const head = await scanComplexity(repoRoot);
    const comparison = compareComplexityReports(
      base,
      head,
      fileChanges(repoRoot, baseRoot, baseCommit, head),
    );
    return { baseCommit, headCommit, ...comparison };
  } finally {
    // Git can register a worktree before checkout fails. Inspect registration
    // instead of inferring it from the add command's exit status.
    const registered = git(repoRoot, ["worktree", "list", "--porcelain", "-z"])
      .replaceAll("\\", "/")
      .split("\0")
      .includes(`worktree ${baseRoot.replaceAll("\\", "/")}`);
    if (registered) git(repoRoot, ["worktree", "remove", "--force", baseRoot]);
    await rm(scratch, { recursive: true, force: true });
  }
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { base: { type: "string" }, json: { type: "boolean" }, github: { type: "boolean" } },
    strict: true,
    allowPositionals: false,
  });
  if (!values.base)
    throw new Error("Usage: bun run complexity:compare --base <ref> [--json] [--github]");
  const comparison = await compareRepositoryComplexity(
    path.resolve(import.meta.dir, ".."),
    values.base,
  );
  const markdown = formatComplexityComparison(comparison);
  if (values.github) {
    const annotations = githubComplexityAnnotations(comparison);
    if (annotations) console.error(annotations);
    if (process.env.GITHUB_STEP_SUMMARY)
      await appendFile(process.env.GITHUB_STEP_SUMMARY, markdown);
  }
  console.log(values.json ? JSON.stringify(comparison, null, 2) : markdown);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
