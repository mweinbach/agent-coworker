import fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const defaultName = process.platform === "win32" ? "cowork-server.exe" : "cowork-server";

function parseOutfile(argv: string[]): string {
  const outIndex = argv.findIndex((arg) => arg === "--outfile" || arg === "-o");
  if (outIndex === -1) return path.join(root, "dist", defaultName);

  const value = argv[outIndex + 1];
  if (!value) throw new Error("Missing value for --outfile");
  return path.isAbsolute(value) ? value : path.join(root, value);
}

async function rmrf(target: string) {
  await fs.rm(target, { recursive: true, force: true });
}

async function copyDir(src: string, dest: string) {
  const anyFs = fs as any;
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
    if (entry.isFile()) await fs.copyFile(from, to);
  }
}

async function main() {
  const outfile = parseOutfile(process.argv.slice(2));
  const outDir = path.dirname(outfile);
  await fs.mkdir(outDir, { recursive: true });

  const entry = path.join(root, "src", "server", "index.ts");
  const args = ["bun", "build", entry, "--compile", "--target", "bun", "--outfile", outfile];

  const proc = Bun.spawn(args, {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  });

  const code = await proc.exited;
  if (code !== 0) process.exit(code);

  for (const dir of ["prompts", "config", "docs"] as const) {
    const dest = path.join(outDir, dir);
    await rmrf(dest);
    await copyDir(path.join(root, dir), dest);
  }

  console.log(`[build] cowork-server binary: ${path.relative(root, outfile)}`);
  console.log(`[build] cowork-server resources: ${path.relative(root, outDir)}/{prompts,config,docs}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
