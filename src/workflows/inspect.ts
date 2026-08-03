import { z } from "zod";

import { compileWorkflowSource } from "./compile";
import { workflowMetaSchema } from "./schema";
import type { WorkflowCompileFailure } from "./types";
import { WORKFLOW_WORKER_BOOTSTRAP } from "./workerBootstrap";

const DEFAULT_INSPECTION_TIMEOUT_MS = 2_000;

const workflowInspectionMessageSchema = z.discriminatedUnion("t", [
  z
    .object({
      t: z.literal("inspected"),
      meta: z.unknown(),
      hasDefault: z.boolean(),
    })
    .strict(),
  z
    .object({
      t: z.literal("error"),
      message: z.string().max(4_000),
      stack: z.string().max(8_000).optional(),
    })
    .strict(),
]);

export type WorkflowDefinitionInspection =
  | WorkflowCompileFailure
  | {
      ok: true;
      js: string;
      sourceHash: string;
      meta: z.infer<typeof workflowMetaSchema>;
    };

export async function inspectWorkflowSource(
  source: string,
  timeoutMs: number = DEFAULT_INSPECTION_TIMEOUT_MS,
): Promise<WorkflowDefinitionInspection> {
  const compiled = compileWorkflowSource(source);
  if (!compiled.ok) return compiled;

  const blobUrl = URL.createObjectURL(
    new Blob([WORKFLOW_WORKER_BOOTSTRAP], { type: "text/javascript" }),
  );
  const worker = new Worker(blobUrl, { type: "module" } as WorkerOptions);
  (worker as unknown as { unref?: () => void }).unref?.();

  try {
    const inspected = await new Promise<z.infer<typeof workflowInspectionMessageSchema>>(
      (resolve, reject) => {
        const timer = setTimeout(
          () => {
            reject(new Error(`workflow metadata inspection exceeded ${timeoutMs}ms`));
          },
          Math.max(1, Math.floor(timeoutMs)),
        );

        worker.onmessage = (event: MessageEvent) => {
          const parsed = workflowInspectionMessageSchema.safeParse(event.data);
          if (!parsed.success) {
            clearTimeout(timer);
            reject(new Error("workflow metadata worker sent an invalid message"));
            return;
          }
          clearTimeout(timer);
          resolve(parsed.data);
        };
        worker.onerror = (event: ErrorEvent) => {
          clearTimeout(timer);
          reject(new Error(event.message || "workflow metadata worker crashed"));
        };
        worker.postMessage({ t: "inspect", js: compiled.js });
      },
    );

    if (inspected.t === "error") {
      return {
        ok: false,
        issues: [{ path: "script", message: inspected.message }],
      };
    }
    if (!inspected.hasDefault) {
      return {
        ok: false,
        issues: [{ path: "exports.default", message: "the default export must be a function" }],
      };
    }

    const meta = workflowMetaSchema.safeParse(inspected.meta);
    if (!meta.success) {
      return {
        ok: false,
        issues: meta.error.issues.map((issue) => ({
          path: `exports.meta.${issue.path.join(".")}`.replace(/\.$/, ""),
          message: issue.message,
        })),
      };
    }

    return {
      ok: true,
      js: compiled.js,
      sourceHash: compiled.sourceHash,
      meta: meta.data,
    };
  } catch (error) {
    return {
      ok: false,
      issues: [
        {
          path: "script",
          message: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  } finally {
    worker.terminate();
    URL.revokeObjectURL(blobUrl);
  }
}
