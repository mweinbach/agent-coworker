import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");
process.chdir(repoRoot);

await import("./bun-test-setup");
