import { z } from "zod";

import type { WorkflowJsonSchema } from "./types";

/** Envelope a workflow child returns when the caller supplied a schema. */
const RESULT_OPEN = "<workflow_result>";
const RESULT_CLOSE = "</workflow_result>";

export function buildSchemaSystemInstruction(): string {
  return [
    "## Workflow structured-output mode",
    "",
    "This call is consumed by a workflow JSON-schema validator.",
    `Return exactly one ${RESULT_OPEN}...${RESULT_CLOSE} block and nothing else.`,
    "The workflow output contract in the user message replaces role-level final-response and report-footer instructions for this call.",
    'Do not emit prose, markdown fences, an "Answer" prefix, or an <agent_report> block.',
  ].join("\n");
}

export function buildSchemaInstruction(schema: WorkflowJsonSchema): string {
  return [
    "",
    "## Required output format",
    "",
    `Reply with ONLY one ${RESULT_OPEN}...${RESULT_CLOSE} block containing`,
    "a single JSON value that validates against this JSON Schema:",
    "",
    "```json",
    JSON.stringify(schema, null, 2),
    "```",
    "",
    `Example: ${RESULT_OPEN}{"field": "value"}${RESULT_CLOSE}`,
    "",
    "Write nothing before or after the block. Do not wrap it in a code fence or add an <agent_report> footer.",
  ].join("\n");
}

export function buildRepairInstruction(issues: string[]): string {
  return [
    `Your ${RESULT_OPEN} block did not validate. Problems:`,
    "",
    ...issues.map((issue) => `- ${issue}`),
    "",
    `Reply with ONLY a corrected ${RESULT_OPEN}...${RESULT_CLOSE} block. No other text.`,
  ].join("\n");
}

/** Pull the last `<workflow_result>` block out of a child's final message. */
export function extractResultEnvelope(text: string | null | undefined): string | null {
  if (!text) return null;
  const open = text.lastIndexOf(RESULT_OPEN);
  if (open === -1) return null;
  const start = open + RESULT_OPEN.length;
  const close = text.indexOf(RESULT_CLOSE, start);
  const body = close === -1 ? text.slice(start) : text.slice(start, close);
  const trimmed = body.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export type SchemaValidation = { ok: true; value: unknown } | { ok: false; issues: string[] };

/**
 * Validate a child's envelope against a caller-supplied JSON Schema.
 *
 * zod 4 ships `z.fromJSONSchema`, so the JSON Schema the script wrote is compiled
 * to a real validator that produces issues with paths. Keeping the schema as data
 * (rather than injecting a live `z` into the sandbox) is what lets the schema be
 * journaled — and stops a script from smuggling `z.refine`, i.e. arbitrary code
 * inside a validator.
 */
export function validateAgainstJsonSchema(
  schema: WorkflowJsonSchema,
  rawEnvelope: string | null,
): SchemaValidation {
  if (rawEnvelope === null) {
    return {
      ok: false,
      issues: [`no ${RESULT_OPEN} block was found in the final message`],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawEnvelope);
  } catch (error) {
    return {
      ok: false,
      issues: [
        `the block was not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }

  let validator: z.ZodType;
  try {
    validator = z.fromJSONSchema(schema as never) as z.ZodType;
  } catch (error) {
    // A malformed schema is the script's bug, not the child's — surface it as-is
    // rather than burning a repair turn on an unsatisfiable contract.
    throw new Error(
      `workflow agent schema is not a usable JSON Schema: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const result = validator.safeParse(parsed);
  if (result.success) return { ok: true, value: result.data };

  return {
    ok: false,
    issues: result.error.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${path}: ${issue.message}`;
    }),
  };
}
