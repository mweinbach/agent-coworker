import fs from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

export type ValidationIssue = {
  code: string;
  message: string;
  path?: string;
};

export type RawLoopValidatorResult = {
  ok: boolean;
  issues: ValidationIssue[];
  warnings: ValidationIssue[];
  data?: unknown;
};

export type ArtifactAssertion =
  | { kind: "exists"; field: string }
  | { kind: "absolute_path"; field: string }
  | { kind: "within_run_dir"; field: string }
  | { kind: "extension"; field: string; ext: string }
  | { kind: "non_empty_file"; field: string }
  | { kind: "text_includes"; field: string; needle: string };

type JsonFinalContract = {
  format: "json";
  schema: z.ZodTypeAny;
  artifactAssertions?: ArtifactAssertion[];
  validateSemantics?: (ctx: {
    runDir: string;
    finalText: string;
    parsed: unknown;
    trace: unknown;
  }) => Promise<RawLoopValidatorResult>;
};

type LinePairsFinalContract = {
  format: "line_pairs";
  schema: z.ZodTypeAny;
  sentinel?: string;
  sentinelKey?: string;
  artifactAssertions?: ArtifactAssertion[];
  validateSemantics?: (ctx: {
    runDir: string;
    finalText: string;
    parsed: unknown;
    trace: unknown;
  }) => Promise<RawLoopValidatorResult>;
};

export type FinalContract = JsonFinalContract | LinePairsFinalContract;

export type FinalContractValidationResult = {
  ok: boolean;
  schemaOk: boolean;
  artifactOk: boolean;
  semanticOk: boolean;
  parsed?: unknown;
  issues: ValidationIssue[];
  warnings: ValidationIssue[];
};

function issue(code: string, message: string, pathValue?: string): ValidationIssue {
  return pathValue ? { code, message, path: pathValue } : { code, message };
}

function getFieldValue(parsed: unknown, field: string): unknown {
  if (!parsed || typeof parsed !== "object") return undefined;
  return (parsed as Record<string, unknown>)[field];
}

async function canonicalizePathForBoundaryCheck(absPath: string): Promise<string> {
  const resolved = path.resolve(absPath);
  try {
    return await fs.realpath(resolved);
  } catch {
    return resolved;
  }
}

function parseJsonFinalOutput(finalText: string): unknown {
  return JSON.parse(finalText.trim());
}

function parseLinePairsFinalOutput(
  finalText: string,
  sentinel = "<<END_RUN>>",
  sentinelKey = "end",
): Record<string, string> {
  const parsed: Record<string, string> = {};
  const lines = finalText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    if (line === sentinel) {
      parsed[sentinelKey] = sentinel;
      continue;
    }

    const delimiterIndex = line.indexOf(":");
    if (delimiterIndex <= 0) {
      throw new Error(`Invalid line-pairs final output line: ${line}`);
    }

    const key = line.slice(0, delimiterIndex).trim();
    const value = line.slice(delimiterIndex + 1).trim();
    if (!key || !value) {
      throw new Error(`Invalid line-pairs final output line: ${line}`);
    }
    parsed[key] = value;
  }

  return parsed;
}

async function validateArtifactAssertions(
  parsed: unknown,
  runDir: string,
  assertions: ArtifactAssertion[],
): Promise<RawLoopValidatorResult> {
  const issues: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  for (const assertion of assertions) {
    const rawValue = getFieldValue(parsed, assertion.field);
    if (typeof rawValue !== "string" || rawValue.trim().length === 0) {
      issues.push(issue("missing_field", `Field "${assertion.field}" must be a non-empty string`, assertion.field));
      continue;
    }

    const value = rawValue.trim();
    switch (assertion.kind) {
      case "absolute_path":
        if (!path.isAbsolute(value)) {
          issues.push(issue("not_absolute", `Field "${assertion.field}" must be an absolute path`, assertion.field));
        }
        break;
      case "within_run_dir": {
        if (!path.isAbsolute(value)) {
          issues.push(issue("not_absolute", `Field "${assertion.field}" must be an absolute path`, assertion.field));
          break;
        }
        const [canonicalRunDir, canonicalValue] = await Promise.all([
          canonicalizePathForBoundaryCheck(runDir),
          canonicalizePathForBoundaryCheck(value),
        ]);
        const relative = path.relative(canonicalRunDir, canonicalValue);
        if (relative.startsWith("..") || path.isAbsolute(relative)) {
          issues.push(issue("outside_run_dir", `Field "${assertion.field}" must stay within the run directory`, assertion.field));
        }
        break;
      }
      case "extension":
        if (!value.toLowerCase().endsWith(assertion.ext.toLowerCase())) {
          issues.push(issue("wrong_extension", `Field "${assertion.field}" must end with ${assertion.ext}`, assertion.field));
        }
        break;
      case "exists": {
        const stat = await fs.stat(value).catch(() => null);
        if (!stat?.isFile()) {
          issues.push(issue("missing_file", `File for "${assertion.field}" does not exist`, assertion.field));
        }
        break;
      }
      case "non_empty_file": {
        const stat = await fs.stat(value).catch(() => null);
        if (!stat?.isFile() || stat.size <= 0) {
          issues.push(issue("empty_file", `File for "${assertion.field}" must exist and be non-empty`, assertion.field));
        }
        break;
      }
      case "text_includes": {
        const contents = await fs.readFile(value, "utf-8").catch(() => null);
        if (contents === null) {
          issues.push(issue("missing_file", `File for "${assertion.field}" does not exist`, assertion.field));
          break;
        }
        if (!contents.includes(assertion.needle)) {
          issues.push(issue(
            "missing_text",
            `File for "${assertion.field}" must include required text: ${assertion.needle}`,
            assertion.field,
          ));
        }
        break;
      }
      default: {
        const _exhaustive: never = assertion;
        warnings.push(issue("unknown_assertion", `Unknown artifact assertion: ${String(_exhaustive)}`));
      }
    }
  }

  return { ok: issues.length === 0, issues, warnings };
}

export async function validateFinalContract(opts: {
  finalText: string;
  runDir: string;
  trace: unknown;
  contract: FinalContract;
}): Promise<FinalContractValidationResult> {
  const issues: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  let parsedCandidate: unknown;
  try {
    parsedCandidate = opts.contract.format === "json"
      ? parseJsonFinalOutput(opts.finalText)
      : parseLinePairsFinalOutput(
          opts.finalText,
          opts.contract.sentinel,
          opts.contract.sentinelKey,
        );
  } catch (error) {
    issues.push(issue(
      "parse_failed",
      `Failed to parse final ${opts.contract.format === "json" ? "JSON" : "line-pairs"} output: ${error instanceof Error ? error.message : String(error)}`,
    ));
    return {
      ok: false,
      schemaOk: false,
      artifactOk: false,
      semanticOk: false,
      issues,
      warnings,
    };
  }

  const schemaResult = opts.contract.schema.safeParse(parsedCandidate);
  if (!schemaResult.success) {
    for (const schemaIssue of schemaResult.error.issues) {
      issues.push(issue(
        "schema_failed",
        schemaIssue.message,
        schemaIssue.path.map(String).join(".") || undefined,
      ));
    }
    return {
      ok: false,
      schemaOk: false,
      artifactOk: false,
      semanticOk: false,
      issues,
      warnings,
    };
  }

  const parsed = schemaResult.data;
  let artifactOk = true;
  if (opts.contract.artifactAssertions && opts.contract.artifactAssertions.length > 0) {
    const artifactResult = await validateArtifactAssertions(parsed, opts.runDir, opts.contract.artifactAssertions);
    issues.push(...artifactResult.issues);
    warnings.push(...artifactResult.warnings);
    artifactOk = artifactResult.ok;
  }

  let semanticOk = true;
  if (opts.contract.validateSemantics) {
    const semanticResult = await opts.contract.validateSemantics({
      runDir: opts.runDir,
      finalText: opts.finalText,
      parsed,
      trace: opts.trace,
    });
    issues.push(...semanticResult.issues);
    warnings.push(...semanticResult.warnings);
    semanticOk = semanticResult.ok;
  }

  return {
    ok: issues.length === 0,
    schemaOk: true,
    artifactOk,
    semanticOk,
    parsed,
    issues,
    warnings,
  };
}

export async function validateWithOptionalRepair<T = undefined>(opts: {
  finalText: string;
  runDir: string;
  trace: unknown;
  contract?: FinalContract;
  strictMode: boolean;
  repairFinalOutput?: () => Promise<{ finalText: string; data?: T }>;
}): Promise<{
  finalText: string;
  repairData?: T;
  validationResult: FinalContractValidationResult;
  repairAttempted: boolean;
  repairSucceeded: boolean;
  degraded: boolean;
}> {
  const initialValidation = opts.contract
    ? await validateFinalContract({
        finalText: opts.finalText,
        runDir: opts.runDir,
        trace: opts.trace,
        contract: opts.contract,
      })
    : {
        ok: opts.finalText.includes("<<END_RUN>>"),
        schemaOk: opts.finalText.includes("<<END_RUN>>"),
        artifactOk: true,
        semanticOk: true,
        issues: opts.finalText.includes("<<END_RUN>>")
          ? []
          : [{ code: "missing_end_run", message: "Final output must include <<END_RUN>>" }],
        warnings: [],
        parsed: undefined,
      };

  if (initialValidation.ok || opts.strictMode || !opts.repairFinalOutput) {
    return {
      finalText: opts.finalText,
      repairData: undefined,
      validationResult: initialValidation,
      repairAttempted: false,
      repairSucceeded: false,
      degraded: false,
    };
  }

  let repairedText: string;
  let repairData: T | undefined;
  try {
    const repaired = await opts.repairFinalOutput();
    repairedText = repaired.finalText;
    repairData = repaired.data;
  } catch (error) {
    return {
      finalText: opts.finalText,
      repairData: undefined,
      validationResult: {
        ...initialValidation,
        ok: false,
        issues: [
          ...initialValidation.issues,
          {
            code: "repair_failed",
            message: `Repair pass failed: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      },
      repairAttempted: true,
      repairSucceeded: false,
      degraded: true,
    };
  }
  const repairedValidation = opts.contract
    ? await validateFinalContract({
        finalText: repairedText,
        runDir: opts.runDir,
        trace: opts.trace,
        contract: opts.contract,
      })
    : {
        ok: repairedText.includes("<<END_RUN>>"),
        schemaOk: repairedText.includes("<<END_RUN>>"),
        artifactOk: true,
        semanticOk: true,
        issues: repairedText.includes("<<END_RUN>>")
          ? []
          : [{ code: "missing_end_run", message: "Final output must include <<END_RUN>>" }],
        warnings: [],
        parsed: undefined,
      };

  return {
    finalText: repairedText,
    repairData,
    validationResult: repairedValidation,
    repairAttempted: true,
    repairSucceeded: repairedValidation.ok,
    degraded: true,
  };
}

export function buildPathArtifactAssertions(
  field: string,
  ext: string,
  extraAssertions: ArtifactAssertion[] = [],
): ArtifactAssertion[] {
  return [
    { kind: "absolute_path", field },
    { kind: "within_run_dir", field },
    { kind: "extension", field, ext },
    { kind: "exists", field },
    { kind: "non_empty_file", field },
    ...extraAssertions,
  ];
}
