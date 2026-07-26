import { createHash } from "node:crypto";

import type { WorkflowCompileResult } from "./types";

/**
 * Static gate + transpile for a model-authored workflow script.
 *
 * Two properties are enforced here, before the source ever reaches the sandbox:
 *
 *  1. **Zero imports.** A live module loader defeats every in-realm capability
 *     trap — `await import("node:fs")` re-obtains anything the realm removed. The
 *     worker also denies `importModuleDynamically`, but rejecting statically gives
 *     the authoring model a clean, in-context error instead of a runtime failure
 *     halfway through a paid run.
 *  2. **Exactly the expected exports.** `meta` (a pure literal) and a default
 *     function. Purity is enforced structurally rather than by an AST walk: host
 *     functions arrive as the default export's argument, so they simply do not
 *     exist during module top-level evaluation.
 *
 * `transformSync` is deliberate — the async transpiler has hit flakiness on
 * Windows behind BUN_FEATURE_FLAG_DISABLE_ASYNC_TRANSPILER, and this is a
 * sub-millisecond operation on scripts this size.
 */
export function compileWorkflowSource(source: string): WorkflowCompileResult {
  const issues: Array<{ path: string; message: string }> = [];
  const trimmed = source.trim();

  if (!trimmed) {
    return { ok: false, issues: [{ path: "script", message: "script is empty" }] };
  }

  const transpiler = new Bun.Transpiler({ loader: "ts" });

  let scan: { exports: string[]; imports: Array<{ path: string }> };
  try {
    scan = transpiler.scan(trimmed) as typeof scan;
  } catch (error) {
    return {
      ok: false,
      issues: [
        {
          path: "script",
          message: `script failed to parse: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }

  if (scan.imports.length > 0) {
    const names = scan.imports.map((entry) => entry.path).join(", ");
    issues.push({
      path: "imports",
      message:
        `workflow scripts may not import anything (found: ${names}). ` +
        "Everything you need is provided as the argument to the default export.",
    });
  }

  if (!scan.exports.includes("meta")) {
    issues.push({
      path: "exports.meta",
      message: "script must `export const meta = { name, description, phases }` as a pure literal",
    });
  }

  if (!scan.exports.includes("default")) {
    issues.push({
      path: "exports.default",
      message:
        "script must `export default async function run({ agent, parallel, pipeline, phase, log, args, budget }) { ... }`",
    });
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  let js: string;
  try {
    js = transpiler.transformSync(trimmed);
  } catch (error) {
    return {
      ok: false,
      issues: [
        {
          path: "script",
          message: `script failed to transpile: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }

  return {
    ok: true,
    js,
    sourceHash: createHash("sha256").update(trimmed).digest("hex"),
  };
}
