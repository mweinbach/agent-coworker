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
  expectedFailureOutput: RegExp;
  marker: string;
  name: "axe" | "renderer" | "visual";
  requiredArtifacts: Array<{ description: string; matches(path: string): boolean }>;
};

const proofs: FailureProof[] = [
  {
    name: "renderer",
    marker: "intentional-quality-gate-renderer-failure",
    expectedFailureOutput: /intentional-quality-gate-renderer-failure/,
    requiredArtifacts: [
      {
        description: "diagnostics JSON",
        matches: (entry) => path.basename(entry).startsWith("quality-gate-diagnostics"),
      },
      {
        description: "Playwright trace",
        matches: (entry) => path.basename(entry).startsWith("quality-gate-trace"),
      },
      { description: "failure screenshot", matches: (entry) => entry.endsWith(".png") },
      { description: "failure video", matches: (entry) => entry.endsWith(".webm") },
    ],
  },
  {
    name: "visual",
    marker: "intentional-quality-gate-visual-failure",
    expectedFailureOutput: /Screenshot comparison failed|pixels \(ratio .*\) are different/i,
    requiredArtifacts: [
      { description: "pixel diff", matches: (entry) => entry.endsWith("-diff.png") },
      { description: "actual screenshot", matches: (entry) => entry.endsWith("-actual.png") },
    ],
  },
  {
    name: "axe",
    marker: "intentional-quality-gate-axe-failure",
    expectedFailureOutput: /button-name: Buttons must have discernible text/,
    requiredArtifacts: [
      {
        description: "Axe result attachment",
        matches: (entry) => path.basename(entry).startsWith("axe-results"),
      },
      {
        description: "diagnostics JSON",
        matches: (entry) => path.basename(entry).startsWith("quality-gate-diagnostics"),
      },
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
  const markerPath = files.find((entry) =>
    path.basename(entry).startsWith("intentional-failure-marker"),
  );
  if (!markerPath) {
    throw new Error(
      `Intentional ${proof.name} failure did not produce its proof marker. Files: ${files.join(", ")}`,
    );
  }
  const markerDocument = JSON.parse(await fs.readFile(markerPath, "utf8")) as unknown;
  if (
    typeof markerDocument !== "object" ||
    markerDocument === null ||
    !("marker" in markerDocument) ||
    markerDocument.marker !== proof.marker ||
    !("proof" in markerDocument) ||
    markerDocument.proof !== proof.name
  ) {
    throw new Error(
      `Intentional ${proof.name} failure produced an invalid marker: ${JSON.stringify(markerDocument)}`,
    );
  }
  const combinedOutput = `${result.stdout}${result.stderr}`;
  if (!proof.expectedFailureOutput.test(combinedOutput)) {
    throw new Error(
      `Intentional ${proof.name} run failed for the wrong reason. Output did not match ${proof.expectedFailureOutput}.\n${combinedOutput}`,
    );
  }
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
