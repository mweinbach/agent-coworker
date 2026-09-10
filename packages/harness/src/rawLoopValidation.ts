import fs from "node:fs/promises";
import path from "node:path";

import type { z } from "zod";

export type ValidationIssue = {
  code: string;
  message: string;
  path?: string;
};

export type RawLoopValidatorResult = {
  ok: boolean;
  issues: ValidationIssue[];
  warnings: ValidationIssue[];
};

export type ArtifactFileAssertion = {
  field: string;
  ext: string;
};

type JsonFinalContract = {
  format: "json";
  schema: z.ZodTypeAny;
  artifactAssertions?: ArtifactFileAssertion[];
  validateSemantics?: (ctx: {
    runDir: string;
    finalText: string;
    parsed: unknown;
    trace: unknown;
  }) => Promise<RawLoopValidatorResult>;
};

export type FinalContract = JsonFinalContract;

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
  return pathValue === undefined ? { code, message } : { code, message, path: pathValue };
}

function getFieldValue(parsed: unknown, field: string): unknown {
  if (parsed === null || typeof parsed !== "object") return undefined;
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

async function validateArtifactFile(
  assertion: ArtifactFileAssertion,
  parsed: unknown,
  runDir: string,
): Promise<ValidationIssue | null> {
  const rawValue = getFieldValue(parsed, assertion.field);
  if (typeof rawValue !== "string" || rawValue.trim().length === 0) {
    return issue(
      "missing_field",
      `Field "${assertion.field}" must be a non-empty string`,
      assertion.field,
    );
  }

  const value = rawValue.trim();
  if (path.isAbsolute(value) === false) {
    return issue(
      "not_absolute",
      `Field "${assertion.field}" must be an absolute path`,
      assertion.field,
    );
  }

  const [canonicalRunDir, canonicalValue] = await Promise.all([
    canonicalizePathForBoundaryCheck(runDir),
    canonicalizePathForBoundaryCheck(value),
  ]);
  const relative = path.relative(canonicalRunDir, canonicalValue);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return issue(
      "outside_run_dir",
      `Field "${assertion.field}" must stay within the run directory`,
      assertion.field,
    );
  }

  if (value.toLowerCase().endsWith(assertion.ext.toLowerCase()) === false) {
    return issue(
      "wrong_extension",
      `Field "${assertion.field}" must end with ${assertion.ext}`,
      assertion.field,
    );
  }

  const stat = await fs.stat(value).catch(() => null);
  if (stat === null || stat.isFile() === false) {
    return issue("missing_file", `File for "${assertion.field}" does not exist`, assertion.field);
  }
  if (stat.size <= 0) {
    return issue(
      "empty_file",
      `File for "${assertion.field}" must exist and be non-empty`,
      assertion.field,
    );
  }
  return null;
}

async function validateArtifactAssertions(
  parsed: unknown,
  runDir: string,
  assertions: ArtifactFileAssertion[],
): Promise<RawLoopValidatorResult> {
  const issues: ValidationIssue[] = [];
  for (const assertion of assertions) {
    const problem = await validateArtifactFile(assertion, parsed, runDir);
    if (problem !== null) {
      issues.push(problem);
    }
  }
  return { ok: issues.length === 0, issues, warnings: [] };
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
    parsedCandidate = JSON.parse(opts.finalText.trim()) as unknown;
  } catch (error) {
    issues.push(
      issue(
        "parse_failed",
        `Failed to parse final JSON output: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
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
  if (schemaResult.success === false) {
    for (const schemaIssue of schemaResult.error.issues) {
      issues.push(
        issue(
          "schema_failed",
          schemaIssue.message,
          schemaIssue.path.map(String).join(".") || undefined,
        ),
      );
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
    const artifactResult = await validateArtifactAssertions(
      parsed,
      opts.runDir,
      opts.contract.artifactAssertions,
    );
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
    if (semanticOk === false && semanticResult.issues.length === 0) {
      issues.push(issue("semantic_failed", "Semantic validation rejected the final output."));
    }
  }

  return {
    ok: artifactOk && semanticOk && issues.length === 0,
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
  const validateCandidate = (
    finalText: string,
  ): FinalContractValidationResult | Promise<FinalContractValidationResult> => {
    if (opts.contract) {
      return validateFinalContract({
        finalText,
        runDir: opts.runDir,
        trace: opts.trace,
        contract: opts.contract,
      });
    }
    const hasEndSentinel = finalText.includes("<<END_RUN>>");
    return {
      ok: hasEndSentinel,
      schemaOk: hasEndSentinel,
      artifactOk: true,
      semanticOk: true,
      issues: hasEndSentinel
        ? []
        : [{ code: "missing_end_run", message: "Final output must include <<END_RUN>>" }],
      warnings: [],
      parsed: undefined,
    };
  };
  const initialValidation = await validateCandidate(opts.finalText);

  if (initialValidation.ok || opts.strictMode || opts.repairFinalOutput === undefined) {
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
  const repairedValidation = await validateCandidate(repairedText);

  return {
    finalText: repairedText,
    repairData,
    validationResult: repairedValidation,
    repairAttempted: true,
    repairSucceeded: repairedValidation.ok,
    degraded: true,
  };
}

export function buildPathArtifactAssertions(field: string, ext: string): ArtifactFileAssertion[] {
  return [{ field, ext }];
}
