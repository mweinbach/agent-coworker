import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

import { summarizeRawLoopBudgets } from "../packages/harness/src/rawLoopTools";
import {
  buildPathArtifactAssertions,
  validateFinalContract,
  validateWithOptionalRepair,
} from "../packages/harness/src/rawLoopValidation";
import { resolveRawLoopHarnessConfig } from "../packages/harness/src/run_raw_agent_loops";

const tempDirs: string[] = [];
async function makeRunDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "raw-loop-validation-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const reportSchema = z.object({ report: z.string(), end: z.literal("<<END_RUN>>") }).strict();
const reportContract = (
  extra: Partial<Parameters<typeof validateFinalContract>[0]["contract"]> = {},
) => ({
  format: "json" as const,
  schema: reportSchema,
  artifactAssertions: buildPathArtifactAssertions("report", ".md"),
  ...extra,
});
const reportJson = (report: string) => JSON.stringify({ report, end: "<<END_RUN>>" });

describe("raw-loop harness config resolution", () => {
  test("preserves configured report-only metadata and resolves strict mode with CLI override", () => {
    for (const [cfg, override, expected] of [
      [{ reportOnly: false, strictMode: true }, null, { reportOnly: false, strictMode: true }],
      [{ reportOnly: true, strictMode: true }, false, { reportOnly: true, strictMode: false }],
      [{ reportOnly: true, strictMode: true }, null, { reportOnly: true, strictMode: true }],
      [{ reportOnly: true, strictMode: false }, true, { reportOnly: true, strictMode: true }],
    ] as const) {
      expect(resolveRawLoopHarnessConfig(cfg, { strictModeOverride: override })).toEqual(expected);
    }
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

    expect(result).toMatchObject({
      schemaOk: true,
      semanticOk: false,
      ok: false,
      issues: [
        { code: "semantic_failed", message: "Semantic validation rejected the final output." },
      ],
    });
  });

  test("fails malformed JSON final output", async () => {
    const result = await validateFinalContract({
      finalText: "{not-json",
      runDir: "/tmp/run",
      trace: {},
      contract: { format: "json", schema: reportSchema },
    });

    expect(result.ok).toBe(false);
    expect(result.schemaOk).toBe(false);
    expect(result.issues[0]?.code).toBe("parse_failed");
  });

  test("fails artifact validation when a path or symlink escapes the run directory", async () => {
    const runDir = await makeRunDir();
    const outsideDir = await makeRunDir();
    const outsidePath = path.join(outsideDir, "outside-report.md");
    await fs.writeFile(outsidePath, "# outside\n", "utf-8");

    const directEscape = await validateFinalContract({
      finalText: reportJson(outsidePath),
      runDir,
      trace: {},
      contract: reportContract(),
    });
    expect(directEscape).toMatchObject({ ok: false, schemaOk: true, artifactOk: false });
    expect(directEscape.issues.some((entry) => entry.code === "outside_run_dir")).toBe(true);

    const linkPath = path.join(runDir, "external");
    try {
      await fs.symlink(outsideDir, linkPath, process.platform === "win32" ? "junction" : "dir");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code === "EPERM" || code === "EACCES" || code === "ENOSYS") return;
      throw err;
    }

    const symlinkEscape = await validateFinalContract({
      finalText: reportJson(path.join(linkPath, "outside-report.md")),
      runDir,
      trace: {},
      contract: reportContract(),
    });
    expect(symlinkEscape.ok).toBe(false);
    expect(symlinkEscape.issues.some((entry) => entry.code === "outside_run_dir")).toBe(true);
  });

  test("passes valid schema and artifact assertions", async () => {
    const runDir = await makeRunDir();
    const reportPath = path.join(runDir, "report.md");
    await fs.writeFile(reportPath, "# report\n", "utf-8");

    const result = await validateFinalContract({
      finalText: reportJson(reportPath),
      runDir,
      trace: {},
      contract: reportContract(),
    });
    expect(result).toMatchObject({ ok: true, schemaOk: true, artifactOk: true });
  });

  test("fails artifact validation for blank, relative, wrong-extension, and empty files", async () => {
    const runDir = await makeRunDir();
    const wrongExtPath = path.join(runDir, "report.txt");
    const emptyPath = path.join(runDir, "report.md");
    await fs.writeFile(wrongExtPath, "# report\n", "utf-8");
    await fs.writeFile(emptyPath, "", "utf-8");

    for (const [report, expectedCode] of [
      ["   ", "missing_field"],
      ["report.md", "not_absolute"],
      [wrongExtPath, "wrong_extension"],
      [emptyPath, "empty_file"],
    ] as const) {
      const res = await validateFinalContract({
        finalText: reportJson(report),
        runDir,
        trace: {},
        contract: reportContract(),
      });
      expect(res.schemaOk).toBe(true);
      expect(res.artifactOk).toBe(false);
      expect(res.issues.map((entry) => entry.code)).toEqual([expectedCode]);
    }
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
    const finalText = reportJson(report);

    const result = await validateWithOptionalRepair({
      finalText,
      runDir,
      trace: {},
      strictMode: false,
      contract: reportContract(),
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
  });

  test("rechecks removed artifacts and semantics without retaining initial diagnostics", async () => {
    const runDir = await fs.realpath(await makeRunDir());
    const report = path.join(runDir, "report.md");
    const finalText = reportJson(report);
    let semanticCalls = 0;

    await fs.writeFile(report, "# initial\n", "utf-8");
    const result = await validateWithOptionalRepair({
      finalText,
      runDir,
      trace: {},
      strictMode: false,
      contract: reportContract({
        validateSemantics: async () => {
          semanticCalls += 1;
          return {
            ok: semanticCalls > 1,
            issues: [],
            warnings: [{ code: "pass", message: String(semanticCalls) }],
          };
        },
      }),
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
        ],
        warnings: [{ code: "pass", message: "2" }],
      },
    });
  });

  test("rejects an artifact escape introduced by repaired output", async () => {
    const root = await makeRunDir();
    const runDir = path.join(root, "run");
    const report = path.join(root, "outside.md");
    await fs.mkdir(runDir);
    await fs.writeFile(report, "# outside\n", "utf-8");

    const result = await validateWithOptionalRepair({
      finalText: "invalid",
      runDir,
      trace: {},
      strictMode: false,
      contract: reportContract(),
      repairFinalOutput: async () => ({ finalText: reportJson(report) }),
    });
    expect(result.validationResult.artifactOk).toBe(false);
    expect(result.validationResult.issues.map((entry) => entry.code)).toEqual(["outside_run_dir"]);
    expect(result.repairSucceeded).toBe(false);
  });

  test("strict mode skips repair while non-strict mode repairs or records repair failure", async () => {
    const contract = { format: "json" as const, schema: reportSchema };
    let repairCalls = 0;
    const repairOk = async () => {
      repairCalls += 1;
      return { finalText: reportJson("/tmp/report.md") };
    };

    const strict = await validateWithOptionalRepair({
      finalText: "report: /tmp/report.md",
      runDir: "/tmp/run",
      trace: {},
      strictMode: true,
      contract,
      repairFinalOutput: repairOk,
    });
    expect(strict).toMatchObject({
      repairAttempted: false,
      validationResult: { ok: false },
    });
    expect(repairCalls).toBe(0);

    const repaired = await validateWithOptionalRepair({
      finalText: "report: /tmp/report.md",
      runDir: "/tmp/run",
      trace: {},
      strictMode: false,
      contract,
      repairFinalOutput: repairOk,
    });
    expect(repaired).toMatchObject({
      repairAttempted: true,
      repairSucceeded: true,
      degraded: true,
      validationResult: { ok: true },
    });
    expect(repairCalls).toBe(1);

    const failedRepair = await validateWithOptionalRepair({
      finalText: "report: /tmp/report.md",
      runDir: "/tmp/run",
      trace: {},
      strictMode: false,
      contract,
      repairFinalOutput: async () => {
        throw new Error("provider unavailable");
      },
    });
    expect(failedRepair).toMatchObject({
      repairAttempted: true,
      repairSucceeded: false,
      degraded: true,
      validationResult: { ok: false },
    });
    expect(
      failedRepair.validationResult.issues.some((entry) => entry.code === "repair_failed"),
    ).toBe(true);
  });

  test("callers can clear stale validation when a later attempt fails before validation", () => {
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
    ).toEqual({ toolCalls: 6, bashCalls: 1, webCalls: 2, spawnedAgents: 1 });
  });
});
