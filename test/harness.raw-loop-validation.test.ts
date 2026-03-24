import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { z } from "zod";

import {
  buildPathArtifactAssertions,
  validateFinalContract,
  validateWithOptionalRepair,
} from "../src/harness/rawLoopValidation";
import {
  resolveRawLoopHarnessConfig,
  summarizeRawLoopBudgets,
} from "../scripts/run_raw_agent_loops";

async function makeRunDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "raw-loop-validation-"));
}

describe("raw-loop harness config resolution", () => {
  test("respects resolved strict mode by default and lets CLI override it", () => {
    expect(resolveRawLoopHarnessConfig(
      { reportOnly: true, strictMode: true },
      { reportOnly: true, strictModeOverride: null },
    )).toEqual({ reportOnly: true, strictMode: true });

    expect(resolveRawLoopHarnessConfig(
      { reportOnly: true, strictMode: false },
      { reportOnly: true, strictModeOverride: true },
    )).toEqual({ reportOnly: true, strictMode: true });

    expect(resolveRawLoopHarnessConfig(
      { reportOnly: true, strictMode: true },
      { reportOnly: true, strictModeOverride: false },
    )).toEqual({ reportOnly: true, strictMode: false });
  });
});

describe("raw-loop final contract validation", () => {
  test("fails malformed JSON final output", async () => {
    const result = await validateFinalContract({
      finalText: "{not-json",
      runDir: "/tmp/run",
      trace: {},
      contract: {
        format: "json",
        schema: z.object({ report: z.string(), end: z.literal("<<END_RUN>>") }).strict(),
      },
    });

    expect(result.ok).toBe(false);
    expect(result.schemaOk).toBe(false);
    expect(result.issues[0]?.code).toBe("parse_failed");
  });

  test("fails artifact validation when a path escapes the run directory", async () => {
    const runDir = await makeRunDir();
    const outsidePath = path.join(os.tmpdir(), "outside-report.md");
    await fs.writeFile(outsidePath, "# outside\n", "utf-8");

    const result = await validateFinalContract({
      finalText: JSON.stringify({
        report: outsidePath,
        end: "<<END_RUN>>",
      }),
      runDir,
      trace: {},
      contract: {
        format: "json",
        schema: z.object({ report: z.string(), end: z.literal("<<END_RUN>>") }).strict(),
        artifactAssertions: buildPathArtifactAssertions("report", ".md"),
      },
    });

    expect(result.ok).toBe(false);
    expect(result.schemaOk).toBe(true);
    expect(result.artifactOk).toBe(false);
    expect(result.issues.some((entry) => entry.code === "outside_run_dir")).toBe(true);
  });

  test("fails artifact validation when a symlink inside the run directory escapes it", async () => {
    const runDir = await makeRunDir();
    const outsideDir = await makeRunDir();
    const outsidePath = path.join(outsideDir, "outside-report.md");
    const linkPath = path.join(runDir, "external");
    const escapedReportPath = path.join(linkPath, "outside-report.md");
    await fs.writeFile(outsidePath, "# outside\n", "utf-8");

    try {
      const symlinkType = process.platform === "win32" ? "junction" : "dir";
      await fs.symlink(outsideDir, linkPath, symlinkType);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code === "EPERM" || code === "EACCES" || code === "ENOSYS") return;
      throw err;
    }

    const result = await validateFinalContract({
      finalText: JSON.stringify({
        report: escapedReportPath,
        end: "<<END_RUN>>",
      }),
      runDir,
      trace: {},
      contract: {
        format: "json",
        schema: z.object({ report: z.string(), end: z.literal("<<END_RUN>>") }).strict(),
        artifactAssertions: buildPathArtifactAssertions("report", ".md"),
      },
    });

    expect(result.ok).toBe(false);
    expect(result.issues.some((entry) => entry.code === "outside_run_dir")).toBe(true);
  });

  test("passes valid schema and artifact assertions", async () => {
    const runDir = await makeRunDir();
    const reportPath = path.join(runDir, "report.md");
    await fs.writeFile(reportPath, "# report\n", "utf-8");

    const result = await validateFinalContract({
      finalText: JSON.stringify({
        report: reportPath,
        end: "<<END_RUN>>",
      }),
      runDir,
      trace: {},
      contract: {
        format: "json",
        schema: z.object({ report: z.string(), end: z.literal("<<END_RUN>>") }).strict(),
        artifactAssertions: buildPathArtifactAssertions("report", ".md"),
      },
    });

    expect(result.ok).toBe(true);
    expect(result.schemaOk).toBe(true);
    expect(result.artifactOk).toBe(true);
  });
});

describe("raw-loop validation repair policy", () => {
  test("strict mode fails without attempting repair", async () => {
    let repairCalls = 0;
    const result = await validateWithOptionalRepair({
      finalText: "report: /tmp/report.md",
      runDir: "/tmp/run",
      trace: {},
      strictMode: true,
      contract: {
        format: "line_pairs",
        schema: z.object({
          report: z.string(),
          end: z.literal("<<END_RUN>>"),
        }).strict(),
      },
      repairFinalOutput: async () => {
        repairCalls += 1;
        return { finalText: "report: /tmp/report.md\n<<END_RUN>>" };
      },
    });

    expect(result.validationResult.ok).toBe(false);
    expect(result.repairAttempted).toBe(false);
    expect(repairCalls).toBe(0);
  });

  test("non-strict mode repairs invalid final output and marks the run degraded", async () => {
    let repairCalls = 0;
    const result = await validateWithOptionalRepair({
      finalText: "report: /tmp/report.md",
      runDir: "/tmp/run",
      trace: {},
      strictMode: false,
      contract: {
        format: "line_pairs",
        schema: z.object({
          report: z.string(),
          end: z.literal("<<END_RUN>>"),
        }).strict(),
      },
      repairFinalOutput: async () => {
        repairCalls += 1;
        return { finalText: "report: /tmp/report.md\n<<END_RUN>>" };
      },
    });

    expect(result.validationResult.ok).toBe(true);
    expect(result.repairAttempted).toBe(true);
    expect(result.repairSucceeded).toBe(true);
    expect(result.degraded).toBe(true);
    expect(repairCalls).toBe(1);
  });

  test("non-strict mode records repair attempt when the repair pass itself fails", async () => {
    const result = await validateWithOptionalRepair({
      finalText: "report: /tmp/report.md",
      runDir: "/tmp/run",
      trace: {},
      strictMode: false,
      contract: {
        format: "line_pairs",
        schema: z.object({
          report: z.string(),
          end: z.literal("<<END_RUN>>"),
        }).strict(),
      },
      repairFinalOutput: async () => {
        throw new Error("provider unavailable");
      },
    });

    expect(result.validationResult.ok).toBe(false);
    expect(result.repairAttempted).toBe(true);
    expect(result.repairSucceeded).toBe(false);
    expect(result.degraded).toBe(true);
    expect(result.validationResult.issues.some((entry) => entry.code === "repair_failed")).toBe(true);
  });

  test("callers can clear stale validation when a later attempt fails before validation", async () => {
    let finalValidation: { issues: Array<{ code: string }> } | null = {
      issues: [{ code: "schema_failed" }],
    };

    try {
      throw new Error("provider offline");
    } catch {
      finalValidation = null;
    }

    expect(finalValidation).toBeNull();
  });
});

describe("raw-loop budget summaries", () => {
  test("counts tool categories deterministically", () => {
    expect(summarizeRawLoopBudgets([
      "todoWrite",
      "bash",
      "webSearch",
      "webFetch",
      "spawnAgent",
      "read",
    ])).toEqual({
      toolCalls: 6,
      bashCalls: 1,
      webCalls: 2,
      spawnedAgents: 1,
    });
  });
});
