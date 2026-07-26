import { z } from "zod";

import type { WorkflowJsonSchema } from "./types";

/**
 * Envelope a child agent is asked to close with when the caller supplied a schema.
 *
 * Deliberately NOT an extension of `<agent_report>`: every child is already
 * prompted to emit that block by `prompts/sub-agents/base.md`, and
 * `reportParser.ts` scrapes it with a fixed schema shared across the product.
 * Widening that contract for workflows would couple two unrelated features.
 */
const RESULT_OPEN = "<workflow_result>";
const RESULT_CLOSE = "</workflow_result>";

export function buildSchemaInstruction(schema: WorkflowJsonSchema): string {
  return [
    "",
    "## Required output format",
    "",
    `Your final message MUST end with a ${RESULT_OPEN}...${RESULT_CLOSE} block containing`,
    "a single JSON value that validates against this JSON Schema:",
    "",
    "```json",
    JSON.stringify(schema, null, 2),
    "```",
    "",
    `Example: ${RESULT_OPEN}{"field": "value"}${RESULT_CLOSE}`,
    "",
    "Write nothing after the closing tag. Do not wrap the block in a code fence.",
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
