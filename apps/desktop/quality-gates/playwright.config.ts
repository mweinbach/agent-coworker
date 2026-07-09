import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "@playwright/test";

const qualityGateRoot = path.dirname(fileURLToPath(import.meta.url));
const outputDir =
  process.env.COWORK_QUALITY_OUTPUT_DIR?.trim() || path.join(qualityGateRoot, "artifacts");
const reportDir =
  process.env.COWORK_QUALITY_REPORT_DIR?.trim() || path.join(qualityGateRoot, "report");

export default defineConfig({
  testDir: path.join(qualityGateRoot, "specs"),
  testMatch: "**/*.pw.ts",
  outputDir,
  snapshotPathTemplate: "{testDir}/../snapshots/{arg}-{platform}{ext}",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  forbidOnly: true,
  timeout: 45_000,
  expect: {
    timeout: 8_000,
    toHaveScreenshot: {
      animations: "disabled",
      caret: "hide",
      scale: "css",
    },
  },
  reporter: [
    ["line"],
    [
      "html",
      {
        open: "never",
        outputFolder: reportDir,
      },
    ],
  ],
});
