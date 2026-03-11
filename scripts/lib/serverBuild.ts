import fs from "node:fs/promises";
import path from "node:path";

export async function rmrf(targetPath: string): Promise<void> {
  await fs.rm(targetPath, { recursive: true, force: true });
}

export async function copyDir(src: string, dest: string): Promise<void> {
  const anyFs = fs as typeof fs & {
    cp?: (source: string, destination: string, options: { recursive: boolean }) => Promise<void>;
  };
  if (typeof anyFs.cp === "function") {
    await anyFs.cp(src, dest, { recursive: true });
    return;
  }

  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(from, to);
      continue;
    }
    if (entry.isSymbolicLink()) continue;
    if (entry.isFile()) {
      await fs.copyFile(from, to);
    }
  }
}

export async function runBunBuild(options: {
  root: string;
  entry: string;
  outdir?: string;
  outfile?: string;
  compile?: boolean;
  env?: Record<string, string | undefined>;
  inlineEnvPatterns?: string[];
  windowsHideConsole?: boolean;
}): Promise<void> {
  const args = ["bun", "build", options.entry];
  if (options.compile) args.push("--compile");
  if (options.outdir) args.push("--outdir", options.outdir);
  if (options.outfile) args.push("--outfile", options.outfile);
  for (const pattern of options.inlineEnvPatterns ?? []) {
    args.push("--env", pattern);
  }
  args.push("--target", "bun");
  if (!options.compile) {
    args.push("--format", "esm");
  }
  if (options.windowsHideConsole) {
    args.push("--windows-hide-console");
  }

  const proc = Bun.spawn(args, {
    cwd: options.root,
    stdout: "inherit",
    stderr: "inherit",
    env: options.env,
  });
  const code = await proc.exited;
  if (code !== 0) {
    process.exit(code);
  }
}

export async function stageBundledServerDist(options: {
  root: string;
  distDir: string;
  includeDocs?: boolean;
}): Promise<void> {
  await fs.mkdir(options.distDir, { recursive: true });
  await rmrf(path.join(options.distDir, "skills"));

  for (const dir of ["prompts", "config"] as const) {
    const src = path.join(options.root, dir);
    const dest = path.join(options.distDir, dir);
    await rmrf(dest);
    await copyDir(src, dest);
  }

  if (options.includeDocs) {
    const docsSrc = path.join(options.root, "docs");
    const docsDest = path.join(options.distDir, "docs");
    await rmrf(docsDest);
    await copyDir(docsSrc, docsDest);
  }
}
