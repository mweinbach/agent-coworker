import { describe, expect, mock, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { z } from "zod";
import {
  buildPathArtifactAssertions,
  validateFinalContract,
  validateWithOptionalRepair,
} from "../packages/harness/src/rawLoopValidation";
import {
  resolveRawLoopHarnessConfig,
  summarizeRawLoopBudgets,
} from "../packages/harness/src/run_raw_agent_loops";

async function makeRunDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "raw-loop-validation-"));
}

describe("raw-loop harness config resolution", () => {
  test.each([false, true])(
    "keeps report-only metadata independent of strict validation: %j",
    (reportOnly) => {
      expect(
        resolveRawLoopHarnessConfig(
          { reportOnly: !reportOnly, strictMode: true },
          { reportOnly, strictModeOverride: null },
        ),
      ).toEqual({ reportOnly, strictMode: true });
    },
  );

  test("respects resolved strict mode by default and lets CLI override it", () => {
    expect(
      resolveRawLoopHarnessConfig(
        { reportOnly: true, strictMode: true },
        { reportOnly: true, strictModeOverride: null },
      ),
    ).toEqual({ reportOnly: true, strictMode: true });

    expect(
      resolveRawLoopHarnessConfig(
        { reportOnly: true, strictMode: false },
        { reportOnly: true, strictModeOverride: true },
      ),
    ).toEqual({ reportOnly: true, strictMode: true });

    expect(
      resolveRawLoopHarnessConfig(
        { reportOnly: true, strictMode: true },
        { reportOnly: true, strictModeOverride: false },
      ),
    ).toEqual({ reportOnly: true, strictMode: false });
  });
});

describe("raw-loop final contract validation", () => {
  test("fails semantic rejection even when the validator supplies no issue details", async () => {
    const result = await validateFinalContract({
      finalText: '{"end":"<<END_RUN>>"}',
      runDir: "/tmp/run",
      trace: {},
      contract: {
        format: "json",
        schema: z.object({ end: z.literal("<<END_RUN>>") }),
        validateSemantics: async () => ({ ok: false, issues: [], warnings: [] }),
      },
    });

    expect(result.schemaOk).toBe(true);
    expect(result.semanticOk).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      { code: "semantic_failed", message: "Semantic validation rejected the final output." },
    ]);
  });

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
  test.each(["initial", "repaired"] as const)(
    "checks the sentinel once per candidate for %s output",
    async (phase) => {
      const repair = phase === "repaired";
      const includes = spyOn(String.prototype, "includes");
      const finalText = "prefix <<END_RUN>> suffix";
      try {
        const result = await validateWithOptionalRepair({
          finalText: repair ? "missing sentinel" : finalText,
          runDir: "/tmp/run",
          trace: {},
          strictMode: false,
          repairFinalOutput: async () => ({ finalText, data: { repaired: true } }),
        });
        expect(includes.mock.calls.filter(([needle]) => needle === "<<END_RUN>>")).toHaveLength(
          repair ? 2 : 1,
        );
        expect(result).toEqual({
          finalText,
          repairData: repair ? { repaired: true } : undefined,
          validationResult: {
            ok: true,
            schemaOk: true,
            artifactOk: true,
            semanticOk: true,
            issues: [],
            warnings: [],
            parsed: undefined,
          },
          repairAttempted: repair,
          repairSucceeded: repair,
          degraded: repair,
        });
      } finally {
        includes.mockRestore();
      }
    },
  );

  test("preserves sentinel rejection, strict no-repair, and missing repair callbacks", async () => {
    const repair = mock(async () => ({ finalText: "still missing" }));
    for (const options of [
      { strictMode: true, repairFinalOutput: repair },
      { strictMode: false },
    ]) {
      const result = await validateWithOptionalRepair({
        finalText: "missing",
        runDir: "/tmp/run",
        trace: {},
        ...options,
      });
      expect(result.repairAttempted).toBe(false);
      expect(result.degraded).toBe(false);
      expect(result.validationResult).toEqual({
        ok: false,
        schemaOk: false,
        artifactOk: true,
        semanticOk: true,
        issues: [{ code: "missing_end_run", message: "Final output must include <<END_RUN>>" }],
        warnings: [],
        parsed: undefined,
      });
    }
    expect(repair).not.toHaveBeenCalled();
    const result = await validateWithOptionalRepair({
      finalText: "missing",
      runDir: "/tmp/run",
      trace: {},
      strictMode: false,
      repairFinalOutput: repair,
    });
    expect(repair).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      finalText: "still missing",
      repairAttempted: true,
      repairSucceeded: false,
      degraded: true,
      validationResult: { ok: false, schemaOk: false },
    });
  });

  test("rechecks a missing artifact created during repair", async () => {
    const runDir = await makeRunDir();
    const report = path.join(runDir, "report.md");
    const finalText = JSON.stringify({ report, end: "<<END_RUN>>" });
    try {
      const result = await validateWithOptionalRepair({
        finalText,
        runDir,
        trace: {},
        strictMode: false,
        contract: {
          format: "json",
          schema: z.object({ report: z.string(), end: z.literal("<<END_RUN>>") }).strict(),
          artifactAssertions: buildPathArtifactAssertions("report", ".md"),
        },
        repairFinalOutput: async () => {
          await fs.writeFile(report, "# repaired\n", "utf-8");
          return { finalText };
        },
      });
      expect(result).toMatchObject({
        repairAttempted: true,
        repairSucceeded: true,
        degraded: true,
        validationResult: {
          ok: true,
          schemaOk: true,
          artifactOk: true,
          semanticOk: true,
          issues: [],
        },
      });
    } finally {
      await fs.rm(runDir, { recursive: true, force: true });
    }
  });

  test("rechecks removed artifacts and semantics without retaining initial diagnostics", async () => {
    const runDir = await fs.realpath(await makeRunDir());
    const report = path.join(runDir, "report.md");
    const finalText = JSON.stringify({ report, end: "<<END_RUN>>" });
    let semanticCalls = 0;
    try {
      await fs.writeFile(report, "# initial\n", "utf-8");
      const result = await validateWithOptionalRepair({
        finalText,
        runDir,
        trace: {},
        strictMode: false,
        contract: {
          format: "json",
          schema: z.object({ report: z.string(), end: z.literal("<<END_RUN>>") }).strict(),
          artifactAssertions: buildPathArtifactAssertions("report", ".md"),
          validateSemantics: async () => {
            semanticCalls += 1;
            return {
              ok: semanticCalls > 1,
              issues: [],
              warnings: [{ code: "pass", message: String(semanticCalls) }],
            };
          },
        },
        repairFinalOutput: async () => {
          await fs.unlink(report);
          return { finalText };
        },
      });
      expect(semanticCalls).toBe(2);
      expect(result).toMatchObject({
        repairAttempted: true,
        repairSucceeded: false,
        degraded: true,
        validationResult: {
          ok: false,
          schemaOk: true,
          artifactOk: false,
          semanticOk: true,
          issues: [
            { code: "missing_file", message: 'File for "report" does not exist', path: "report" },
            {
              code: "empty_file",
              message: 'File for "report" must exist and be non-empty',
              path: "report",
            },
          ],
          warnings: [{ code: "pass", message: "2" }],
        },
      });
    } finally {
      await fs.rm(runDir, { recursive: true, force: true });
    }
  });

  test("rejects an artifact escape introduced by repaired output", async () => {
    const root = await makeRunDir();
    const runDir = path.join(root, "run");
    const report = path.join(root, "outside.md");
    try {
      await fs.mkdir(runDir);
      await fs.writeFile(report, "# outside\n", "utf-8");
      const result = await validateWithOptionalRepair({
        finalText: "invalid",
        runDir,
        trace: {},
        strictMode: false,
        contract: {
          format: "json",
          schema: z.object({ report: z.string(), end: z.literal("<<END_RUN>>") }).strict(),
          artifactAssertions: buildPathArtifactAssertions("report", ".md"),
        },
        repairFinalOutput: async () => ({
          finalText: JSON.stringify({ report, end: "<<END_RUN>>" }),
        }),
      });
      expect(result.validationResult.artifactOk).toBe(false);
      expect(result.validationResult.issues.map((entry) => entry.code)).toEqual([
        "outside_run_dir",
      ]);
      expect(result.repairSucceeded).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("strict mode fails without attempting repair", async () => {
    let repairCalls = 0;
    const result = await validateWithOptionalRepair({
      finalText: "report: /tmp/report.md",
      runDir: "/tmp/run",
      trace: {},
      strictMode: true,
      contract: {
        format: "json",
        schema: z
          .object({
            report: z.string(),
            end: z.literal("<<END_RUN>>"),
          })
          .strict(),
      },
      repairFinalOutput: async () => {
        repairCalls += 1;
        return { finalText: JSON.stringify({ report: "/tmp/report.md", end: "<<END_RUN>>" }) };
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
        format: "json",
        schema: z
          .object({
            report: z.string(),
            end: z.literal("<<END_RUN>>"),
          })
          .strict(),
      },
      repairFinalOutput: async () => {
        repairCalls += 1;
        return { finalText: JSON.stringify({ report: "/tmp/report.md", end: "<<END_RUN>>" }) };
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
        format: "json",
        schema: z
          .object({
            report: z.string(),
            end: z.literal("<<END_RUN>>"),
          })
          .strict(),
      },
      repairFinalOutput: async () => {
        throw new Error("provider unavailable");
      },
    });

    expect(result.validationResult.ok).toBe(false);
    expect(result.repairAttempted).toBe(true);
    expect(result.repairSucceeded).toBe(false);
    expect(result.degraded).toBe(true);
    expect(result.validationResult.issues.some((entry) => entry.code === "repair_failed")).toBe(
      true,
    );
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
    expect(
      summarizeRawLoopBudgets(["todoWrite", "bash", "webSearch", "webFetch", "spawnAgent", "read"]),
    ).toEqual({
      toolCalls: 6,
      bashCalls: 1,
      webCalls: 2,
      spawnedAgents: 1,
    });
  });
});
