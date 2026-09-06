import { z } from "zod";

import { CODE_MODE_WORKER_SOURCE } from "./codeModeWorker";
import type { RuntimeToolDefinition, RuntimeToolExecutionOptions } from "./types";

/** Catalog owns schema validation, authorization, and reserved-tool rejection. */
export interface CodeModeCatalog {
  search(input: { query: string }, options?: RuntimeToolExecutionOptions): unknown;
  call(input: { name: string; arguments: unknown }, options?: RuntimeToolExecutionOptions): unknown;
}

export type CodeModeLimits = {
  timeoutMs: number;
  maxSourceBytes: number;
  maxArgumentBytes: number;
  maxOutputBytes: number;
  /** Includes both call and search operations, including queued operations. */
  maxCalls: number;
  maxConcurrency: number;
};

const DEFAULT_LIMITS: CodeModeLimits = {
  timeoutMs: 30_000,
  maxSourceBytes: 64 * 1024,
  maxArgumentBytes: 64 * 1024,
  maxOutputBytes: 1024 * 1024,
  maxCalls: 64,
  maxConcurrency: 4,
};

const inputSchema = z
  .object({
    code: z
      .string()
      .min(1)
      .describe(
        "Async JavaScript function body. Use tools.call(name, args), tools.search(query), and return JSON data.",
      ),
  })
  .strict();
const requestSchema = z.object({
  t: z.literal("request"),
  id: z.number().int().nonnegative(),
  operation: z.enum(["call", "search"]),
  payload: z.string(),
});
type Request = z.infer<typeof requestSchema>;

function errorText(error: unknown): string {
  try {
    return (error instanceof Error ? error.message : String(error)).slice(0, 4000);
  } catch {
    return "code mode failed";
  }
}

/**
 * Opt-in provider-neutral primitive; callers decide whether to register it.
 * `code` is an async function BODY with tools.call(name, args) and
 * tools.search(query). Results retain their JSON structure, including citations.
 *
 * Timeout/cancellation immediately terminates the Worker and aborts catalog
 * calls, but execute does not settle until every dispatched host call settles.
 * A catalog ignoring abort can therefore extend teardown indefinitely. vm is an
 * in-process capability restriction, not an OS sandbox or memory limit.
 */
export function createCodeModeTool(options: {
  catalog: CodeModeCatalog;
  abortSignal?: AbortSignal;
  limits?: Partial<CodeModeLimits>;
}): RuntimeToolDefinition {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`code mode ${name} must be a positive safe integer`);
    }
  }
  if (limits.timeoutMs > 30_000) throw new Error("code mode timeoutMs must not exceed 30000");

  return {
    description:
      "Execute a JavaScript async function body using only tools.call(name, arguments) and " +
      "tools.search(query). Return JSON data. No imports, filesystem, process, or network APIs. " +
      "Tool calls use the authorized catalog. " +
      `At most ${limits.maxCalls} calls/searches, ${limits.maxConcurrency} concurrent, ` +
      `${limits.timeoutMs}ms execution, ${limits.maxSourceBytes} UTF-8 source bytes, ` +
      `${limits.maxArgumentBytes} input bytes per call and ${limits.maxOutputBytes} output bytes.`,
    inputSchema,
    async execute(input, executionOptions) {
      const { code } = inputSchema.parse(input);
      if (Buffer.byteLength(code, "utf8") > limits.maxSourceBytes) {
        throw new Error("code mode source exceeds maxSourceBytes");
      }
      const signals = [...new Set([options.abortSignal, executionOptions?.abortSignal])].filter(
        (signal): signal is AbortSignal => signal !== undefined,
      );
      if (signals.some((signal) => signal.aborted)) throw new Error("code mode cancelled");

      const controller = new AbortController();
      const blobUrl = URL.createObjectURL(
        new Blob([CODE_MODE_WORKER_SOURCE], { type: "text/javascript" }),
      );
      let worker: Worker;
      try {
        worker = new Worker(blobUrl, { type: "module" } as WorkerOptions);
      } catch (error) {
        URL.revokeObjectURL(blobUrl);
        throw error;
      }

      const inflight = new Set<Promise<void>>();
      const queue: Request[] = [];
      const seen = new Set<number>();
      let terminal = false;
      let resolve!: (value: unknown) => void;
      let reject!: (error: Error) => void;
      const result = new Promise<unknown>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => finish(new Error("code mode cancelled"));
      const finish = (error?: Error, value?: unknown) => {
        if (terminal) return;
        terminal = true;
        clearTimeout(timer);
        for (const signal of signals) signal.removeEventListener("abort", onAbort);
        queue.length = 0;
        try {
          worker.terminate();
        } catch {
          // A worker already terminated by the runtime must not skip call drain.
        }
        URL.revokeObjectURL(blobUrl);
        // Stop admission before delivering abort to possibly reentrant tools.
        if (error) controller.abort(error);
        void (async () => {
          while (inflight.size > 0) await Promise.allSettled([...inflight]);
          if (error) reject(error);
          else resolve(value);
        })();
      };
      const post = (message: unknown) => {
        if (terminal) return;
        try {
          worker.postMessage(message);
        } catch (error) {
          finish(new Error(`code mode transport failed: ${errorText(error)}`));
        }
      };
      const dispatch = async (request: Request) => {
        let payload: string;
        try {
          const input = JSON.parse(request.payload);
          const value = await (request.operation === "call"
            ? options.catalog.call(input, { abortSignal: controller.signal })
            : options.catalog.search(input, { abortSignal: controller.signal }));
          // Do not flatten content blocks, sources, citations, or result wrappers.
          payload = JSON.stringify({ ok: true, value: value === undefined ? null : value });
          if (Buffer.byteLength(payload, "utf8") > limits.maxOutputBytes) {
            throw new Error("code mode tool result exceeds maxOutputBytes");
          }
        } catch (error) {
          payload = JSON.stringify({ ok: false, message: errorText(error) });
        }
        post({ t: "result", id: request.id, payload });
      };
      const pump = () => {
        while (!terminal && queue.length > 0 && inflight.size < limits.maxConcurrency) {
          const request = queue.shift();
          if (!request) break;
          // Register ownership BEFORE invoking catalog code (which can abort
          // synchronously). A finally-created promise must also remain observed.
          const task = Promise.resolve().then(async () => {
            if (!terminal) await dispatch(request);
          });
          inflight.add(task);
          void task.then(
            () => {
              inflight.delete(task);
              pump();
            },
            (error) => {
              inflight.delete(task);
              finish(new Error(errorText(error)));
            },
          );
        }
      };

      worker.onmessage = ({ data }) => {
        if (terminal) return;
        if (data?.t === "request") {
          const parsed = requestSchema.safeParse(data);
          if (!parsed.success) {
            finish(new Error("invalid code mode request"));
            return;
          }
          const request = parsed.data;
          if (seen.has(request.id) || seen.size >= limits.maxCalls) {
            finish(new Error(`code mode exceeded maxCalls (${limits.maxCalls})`));
            return;
          }
          if (Buffer.byteLength(request.payload, "utf8") > limits.maxArgumentBytes) {
            finish(new Error("code mode tool input exceeds maxArgumentBytes"));
            return;
          }
          seen.add(request.id);
          queue.push(request);
          pump();
        } else if (data?.t === "done" && typeof data.payload === "string") {
          try {
            if (Buffer.byteLength(data.payload, "utf8") > limits.maxOutputBytes) {
              throw new Error("code mode output exceeds maxOutputBytes");
            }
            finish(undefined, JSON.parse(data.payload));
          } catch (error) {
            finish(new Error(errorText(error)));
          }
        } else if (data?.t === "error") {
          finish(new Error(errorText(data.message)));
        } else {
          finish(new Error("invalid code mode worker message"));
        }
      };
      worker.onerror = (event) => {
        event.preventDefault();
        finish(new Error(`code mode worker failed: ${event.message}`));
      };
      timer = setTimeout(
        () => finish(new Error(`code mode timed out after ${limits.timeoutMs}ms`)),
        limits.timeoutMs,
      );
      for (const signal of signals) signal.addEventListener("abort", onAbort, { once: true });
      if (signals.some((signal) => signal.aborted)) onAbort();
      post({ t: "start", code, limits });
      return await result;
    },
  };
}
