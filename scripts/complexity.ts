import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const RULE = "lint/complexity/noExcessiveCognitiveComplexity";
const biomeReportSchema = z.object({
  summary: z.object({
    unchanged: z.number().int().positive(),
    errors: z.literal(0),
    diagnosticsNotPrinted: z.literal(0),
  }),
  diagnostics: z.array(
    z.object({
      category: z.string().nullable(),
      message: z.string(),
      location: z.unknown().optional(),
    }),
  ),
});
const locationSchema = z.object({
  path: z.string().min(1),
  start: z.object({ line: z.number().int().positive() }),
});

type TrackedFile = { path: string; lines: number | null };

export function buildComplexityReport(files: TrackedFile[], rawBiomeReport: unknown) {
  // Biome's JSON reporter is experimental. Fail on incomplete or changed output
  // rather than recording an apparently successful zero-complexity scan.
  const biome = biomeReportSchema.parse(rawBiomeReport);
  const areas = new Map<string, { area: string; files: number; textLines: number }>();
  for (const file of files) {
    const parts = file.path.split("/");
    const area =
      parts.length === 1
        ? "(root)"
        : ["apps", "packages", "crates"].includes(parts[0])
          ? parts.slice(0, 2).join("/")
          : file.path.startsWith("src/server/")
            ? "src/server"
            : parts[0];
    const summary = areas.get(area) ?? { area, files: 0, textLines: 0 };
    summary.files += 1;
    summary.textLines += file.lines ?? 0;
    areas.set(area, summary);
  }

  const hotspots = biome.diagnostics
    .filter((diagnostic) => diagnostic.category === RULE)
    .map((diagnostic) => {
      const score = /^Excessive complexity of (\d+) detected \(max: 15\)\.$/.exec(
        diagnostic.message,
      )?.[1];
      if (!score || Number(score) <= 15) {
        throw new Error(`Unexpected Biome complexity diagnostic: ${diagnostic.message}`);
      }
      const location = locationSchema.parse(diagnostic.location);
      const filePath = location.path.replaceAll("\\", "/");
      return {
        path: filePath,
        line: location.start.line,
        score: Number(score),
        test: /(^|\/)(tests?|quality-gates)\/|\.(test|spec|pw)\.[^.]+$/.test(filePath),
      };
    })
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path, "en") || a.line - b.line);

  return {
    trackedFiles: files.length,
    textLines: files.reduce((total, file) => total + (file.lines ?? 0), 0),
    scannedFiles: biome.summary.unchanged,
    areas: [...areas.values()].sort((a, b) => a.area.localeCompare(b.area, "en")),
    hotspots,
  };
}

function run(command: string[], cwd: string): string {
  const result = Bun.spawnSync(command, { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed:\n${result.stderr.toString()}`);
  }
  return result.stdout.toString();
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--json")) {
    throw new Error("Usage: bun run complexity [--json]");
  }
  const repoRoot = path.resolve(import.meta.dir, "..");
  const deleted = new Set(run(["git", "ls-files", "--deleted", "-z"], repoRoot).split("\0"));
  const paths = run(["git", "ls-files", "-z"], repoRoot)
    .split("\0")
    .filter((file) => file && !deleted.has(file));
  const files: TrackedFile[] = [];
  for (const filePath of paths) {
    const absolutePath = path.join(repoRoot, filePath);
    // Count symlinks and submodules, but never follow them into untracked data.
    const stat = await lstat(absolutePath);
    let lines: number | null = null;
    if (stat.isFile()) {
      const bytes = await readFile(absolutePath);
      if (!bytes.includes(0)) {
        const text = bytes.toString("utf8");
        lines = text.length === 0 ? 0 : text.split("\n").length - Number(text.endsWith("\n"));
      }
    }
    files.push({ path: filePath, lines });
  }
  const biome = run(
    [
      process.execPath,
      "run",
      "--silent",
      "biome",
      "lint",
      ".",
      "--only=complexity/noExcessiveCognitiveComplexity",
      "--reporter=json",
      "--max-diagnostics=none",
    ],
    repoRoot,
  );
  const report = buildComplexityReport(files, JSON.parse(biome));
  if (args.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(
    `${report.trackedFiles} tracked paths; ${report.textLines} text lines; ` +
      `${report.scannedFiles} Biome-scanned files; ${report.hotspots.length} functions above 15.\n`,
  );
  console.log("| Area | Tracked files | Text lines |\n| --- | ---: | ---: |");
  for (const area of report.areas) {
    console.log(`| ${area.area} | ${area.files} | ${area.textLines} |`);
  }
  console.log("\n| Largest cognitive hotspots | Score | Kind |\n| --- | ---: | --- |");
  for (const hotspot of report.hotspots.slice(0, 30)) {
    console.log(
      `| ${hotspot.path}:${hotspot.line} | ${hotspot.score} | ${hotspot.test ? "test" : "source"} |`,
    );
  }
  console.log(
    "\nInventory includes every tracked path. Cognitive scores use biome.json's JS/TS scope. " +
      "Generated/vendor/native files need separate review; --json includes all hotspots. " +
      "This is an advisory report, not a complexity budget or a replacement for tests.",
  );
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
