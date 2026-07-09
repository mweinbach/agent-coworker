import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const qualityGateRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(qualityGateRoot, "../../..");
const configPath = path.join(qualityGateRoot, "playwright.config.ts");
const specPath = path.join(qualityGateRoot, "specs/failure-proofs.pw.ts");
const proofRoot = path.join(qualityGateRoot, "proof-artifacts");

type FailureProof = {
  name: "axe" | "renderer" | "visual";
  requiredArtifacts: Array<{ description: string; matches(path: string): boolean }>;
};

const proofs: FailureProof[] = [
  {
    name: "renderer",
    requiredArtifacts: [
      { description: "diagnostics JSON", matches: (entry) => entry.endsWith("diagnostics.json") },
      { description: "Playwright trace", matches: (entry) => entry.endsWith("trace.zip") },
      { description: "failure screenshot", matches: (entry) => entry.endsWith(".png") },
      { description: "failure video", matches: (entry) => entry.endsWith(".webm") },
    ],
  },
  {
    name: "visual",
    requiredArtifacts: [
      { description: "pixel diff", matches: (entry) => entry.endsWith("-diff.png") },
      { description: "actual screenshot", matches: (entry) => entry.endsWith("-actual.png") },
    ],
  },
  {
    name: "axe",
    requiredArtifacts: [
      {
        description: "Axe result attachment",
        matches: (entry) => path.basename(entry).startsWith("axe-results"),
      },
      { description: "diagnostics JSON", matches: (entry) => entry.endsWith("diagnostics.json") },
    ],
  },
];

async function listFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
      } else {
        files.push(absolutePath);
      }
    }
  }
  await visit(root);
  return files;
}

await fs.rm(proofRoot, { force: true, recursive: true });
await fs.mkdir(proofRoot, { recursive: true });

for (const proof of proofs) {
  const outputDir = path.join(proofRoot, proof.name);
  const result = spawnSync(
    process.execPath,
    [
      "x",
      "playwright",
      "test",
      "--config",
      configPath,
      specPath,
      "--grep",
      `proof:${proof.name}`,
      "--workers",
      "1",
      "--retries",
      "0",
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        COWORK_QUALITY_OUTPUT_DIR: outputDir,
        COWORK_QUALITY_PROOF: proof.name,
        COWORK_QUALITY_REPORT_DIR: path.join(proofRoot, `${proof.name}-report`),
      },
    },
  );

  await fs.writeFile(
    path.join(proofRoot, `${proof.name}.log`),
    `${result.stdout}${result.stderr}`,
    "utf8",
  );
  if (result.status === 0) {
    throw new Error(`Intentional ${proof.name} failure unexpectedly passed`);
  }
  if (result.error) {
    throw result.error;
  }

  const files = await listFiles(outputDir);
  for (const required of proof.requiredArtifacts) {
    if (!files.some(required.matches)) {
      throw new Error(
        `Intentional ${proof.name} failure did not produce ${required.description}. Files: ${files.join(
          ", ",
        )}`,
      );
    }
  }
  console.log(`Verified intentional ${proof.name} failure and diagnostic artifacts.`);
}
