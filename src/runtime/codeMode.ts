import { randomUUID } from "node:crypto";
import { z } from "zod";

import { type CodeModeProcessSpawner, spawnCodeModeProcess } from "../platform/codeModeProcess";
import { CodeModeFrameDecoder, encodeCodeModeFrame } from "./codeModeTransport";
import { codeModeProcessSource } from "./codeModeWorker";
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
  /** Hard OS memory limit for the disposable executor tree, not the harness. */
  maxMemoryBytes: number;
  /** Total stdin+stdout bytes, including wire escaping and all nested results. */
  maxTransportBytes: number;
  /** Includes both call and search operations, including queued operations. */
  maxCalls: number;
  maxConcurrency: number;
};

const DEFAULT_LIMITS: CodeModeLimits = {
  timeoutMs: 30_000,
  maxSourceBytes: 64 * 1024,
  maxArgumentBytes: 64 * 1024,
  maxOutputBytes: 1024 * 1024,
  maxMemoryBytes: 256 * 1024 * 1024,
  maxTransportBytes: 16 * 1024 * 1024,
  maxCalls: 64,
  maxConcurrency: 4,
};

const MAX_LIMITS: CodeModeLimits = {
  timeoutMs: 30_000,
  maxSourceBytes: 256 * 1024,
  maxArgumentBytes: 256 * 1024,
  maxOutputBytes: 8 * 1024 * 1024,
  maxMemoryBytes: 1024 * 1024 * 1024,
  maxTransportBytes: 64 * 1024 * 1024,
  maxCalls: 1024,
  maxConcurrency: 32,
};

type CallIdentity = {
  executionId: string;
  /** Stable per occurrence, including repeated calls to the same tool. */
  callId: string;
  operation: "call" | "search";
  name: string;
};

export type CodeModeCallEvent = CallIdentity &
  (
    | { phase: "start"; input: unknown }
    | {
        phase: "end";
        status: "succeeded" | "failed" | "cancelled";
        durationMs: number;
        output?: unknown;
        error?: string;
      }
  );

export type CodeModeToolOptions = {
  catalog: CodeModeCatalog;
  abortSignal?: AbortSignal;
  limits?: Partial<CodeModeLimits>;
  /**
   * Generic lifecycle seam: adapters can project nested calls without adding a
   * public protocol. Awaited in occurrence order until execution terminates;
   * observer failures (including late rejections) are isolated. A started host
   * call owns end delivery even after cancellation, but not an unbounded wait
   * for the observer. Observers receive the execution's effective abort signal.
   */
  onCallEvent?: (
    event: CodeModeCallEvent,
    executionOptions?: RuntimeToolExecutionOptions,
  ) => void | Promise<void>;
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
 * Timeout/cancellation immediately terminates the process and aborts catalog
 * calls, but execute does not settle until every dispatched host call settles.
 * A catalog ignoring abort can therefore extend teardown indefinitely.
 * Unsupported OS resource enforcement fails closed, never runs in a Worker.
 */
export function createCodeModeTool(
  options: CodeModeToolOptions,
  /** Trusted dependency injection for deterministic transport/realm tests only. */
  dependencies: { spawnProcess: CodeModeProcessSpawner } = { spawnProcess: spawnCodeModeProcess },
): RuntimeToolDefinition {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`code mode ${name} must be a positive safe integer`);
    }
    if (value > MAX_LIMITS[name as keyof CodeModeLimits]) {
      throw new Error(
        `code mode ${name} must not exceed ${MAX_LIMITS[name as keyof CodeModeLimits]}`,
      );
    }
  }

  return {
    description:
      "Execute a JavaScript async function body using only tools.call(name, arguments) and " +
      "tools.search(query). Return JSON data. No imports, filesystem, process, or network APIs. " +
      "Tool calls use the authorized catalog. " +
      `At most ${limits.maxCalls} calls/searches, ${limits.maxConcurrency} concurrent, ` +
      `${limits.timeoutMs}ms execution, ${limits.maxSourceBytes} UTF-8 source bytes, ` +
      `${limits.maxArgumentBytes} input bytes per call, ${limits.maxOutputBytes} output bytes, ` +
      `${limits.maxMemoryBytes} bytes OS-enforced executor memory, ` +
      `${limits.maxTransportBytes} total IPC bytes. ` +
      "Requires Linux cgroup-v2 delegation and OS sandbox; fails closed elsewhere.",
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
      const executionId = randomUUID();
      // JSON escaping can expand a byte sixfold; metadata/error overhead is
      // fixed and bounded. These are wire caps, not post-deserialization caps.
      const maxFrameBytes =
        6 * Math.max(limits.maxSourceBytes, limits.maxArgumentBytes, limits.maxOutputBytes) + 8192;
      const executor = dependencies.spawnProcess({
        source: codeModeProcessSource(maxFrameBytes),
        maxMemoryBytes: limits.maxMemoryBytes,
      });
      const { child } = executor;

      const inflight = new Set<Promise<void>>();
      let stopExecution!: () => void;
      const executionStopped = new Promise<void>((res) => {
        stopExecution = res;
      });
      const queue: Request[] = [];
      const seen = new Set<number>();
      let terminal = false;
      let ready = false;
      let transportBytes = 0;
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
        // Release telemetry and pending pipe reads on EVERY terminal path,
        // including success (which clears the deadline without aborting calls).
        stopExecution();
        clearTimeout(timer);
        for (const signal of signals) signal.removeEventListener("abort", onAbort);
        queue.length = 0;
        // No more protocol writes are admitted. Release our pipe writer too;
        // externally killing the child is not a substitute for closing stdin.
        try {
          child.endStdin?.();
        } catch {
          // A broken/already-closed pipe must not prevent kill/reap or call drain.
        }
        // Stop admission before delivering abort to possibly reentrant tools.
        if (error) controller.abort(error);
        // Observe teardown failures immediately but do not lose ownership of
        // catalog promises when kill/reap or cgroup cleanup fails.
        const disposal = Promise.resolve()
          .then(() => executor.dispose())
          .then(
            () => undefined,
            (failure) => new Error(`code mode teardown failed: ${errorText(failure)}`),
          );
        void (async () => {
          while (inflight.size > 0) await Promise.allSettled([...inflight]);
          const disposalError = await disposal;
          if (disposalError) reject(disposalError);
          else if (error) reject(error);
          else resolve(value);
        })();
      };
      const post = (message: unknown) => {
        if (terminal) return;
        try {
          if (!child.writeStdin) throw new Error("missing executor stdin");
          const frame = encodeCodeModeFrame(message, maxFrameBytes);
          transportBytes += Buffer.byteLength(frame, "utf8");
          if (transportBytes > limits.maxTransportBytes) {
            throw new Error("code mode exceeded maxTransportBytes");
          }
          child.writeStdin(frame);
        } catch (error) {
          finish(new Error(`code mode transport failed: ${errorText(error)}`));
        }
      };
      const notify = async (event: CodeModeCallEvent) => {
        try {
          // Invoke even after termination so a drained host call still delivers
          // its end event. Race only observer ownership, never the catalog call.
          // Promise.race retains a rejection handler if the observer loses.
          await Promise.race([
            options.onCallEvent?.(event, {
              ...executionOptions,
              abortSignal: controller.signal,
            }),
            executionStopped,
          ]);
        } catch {
          // Telemetry must not turn an already completed side effect into a
          // reported tool failure or suppress cancellation/call ownership.
        }
      };
      const dispatch = async (request: Request) => {
        let payload: string;
        const input = JSON.parse(request.payload);
        const identity: CallIdentity = {
          executionId,
          callId: `${executionId}:${request.id}`,
          operation: request.operation,
          name: request.operation === "search" ? "toolSearch" : String(input?.name ?? ""),
        };
        const startedAt = performance.now();
        await notify({ ...identity, phase: "start", input: JSON.parse(request.payload) });
        let end: CodeModeCallEvent;
        try {
          if (terminal) throw new Error("code mode cancelled");
          const nestedOptions = { ...executionOptions, abortSignal: controller.signal };
          const value = await (request.operation === "call"
            ? options.catalog.call(input, nestedOptions)
            : options.catalog.search(input, nestedOptions));
          // Do not flatten content blocks, sources, citations, or result wrappers.
          payload = JSON.stringify({ ok: true, value: value === undefined ? null : value });
          if (Buffer.byteLength(payload, "utf8") > limits.maxOutputBytes) {
            throw new Error("code mode tool result exceeds maxOutputBytes");
          }
          end = {
            ...identity,
            phase: "end",
            status: controller.signal.aborted ? "cancelled" : "succeeded",
            durationMs: performance.now() - startedAt,
            // Decouple observers from catalog-owned mutable objects.
            output: JSON.parse(payload).value,
          };
        } catch (error) {
          payload = JSON.stringify({ ok: false, message: errorText(error) });
          end = {
            ...identity,
            phase: "end",
            status: controller.signal.aborted ? "cancelled" : "failed",
            durationMs: performance.now() - startedAt,
            error: errorText(error),
          };
        }
        await notify(end);
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

      const receive = (message: unknown) => {
        if (terminal) return;
        if (!message || typeof message !== "object" || !("t" in message)) {
          finish(new Error("invalid code mode process message"));
          return;
        }
        const data = message as Record<string, unknown>;
        if (!ready) {
          if (data.t !== "ready") {
            finish(new Error("code mode executor did not become ready"));
            return;
          }
          ready = true;
          post({ t: "start", code, limits });
        } else if (data.t === "request") {
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
          finish(new Error("invalid code mode process message"));
        }
      };
      const decoder = new CodeModeFrameDecoder(maxFrameBytes);
      const getReader = (stream: ReadableStream<Uint8Array>) => {
        const reader = stream.getReader();
        // Process exit/tree-kill completion is not ownership of a pending pipe
        // read. In particular, Windows taskkill terminates outside Bun's child
        // handle. Do not depend on an EOF callback to reach the finally block:
        // cancellation must wake a reader already suspended in reader.read().
        void executionStopped.then(() => reader.cancel()).catch(() => {});
        return reader;
      };
      const readOutput = async () => {
        const reader = getReader(child.stdout);
        try {
          while (!terminal) {
            const { done, value } = await reader.read();
            if (done) {
              decoder.end();
              break;
            }
            transportBytes += value.byteLength;
            if (transportBytes > limits.maxTransportBytes) {
              throw new Error("code mode exceeded maxTransportBytes");
            }
            decoder.push(value, receive);
          }
          if (!terminal) finish(new Error("code mode process exited without a result"));
        } catch (error) {
          finish(new Error(`code mode transport failed: ${errorText(error)}`));
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      };
      const readErrors = async () => {
        const reader = getReader(child.stderr);
        let bytes = 0;
        try {
          while (!terminal) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > 16 * 1024) finish(new Error("code mode stderr exceeds transport limit"));
          }
        } catch (error) {
          finish(new Error(`code mode stderr failed: ${errorText(error)}`));
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      };
      timer = setTimeout(
        () => finish(new Error(`code mode timed out after ${limits.timeoutMs}ms`)),
        limits.timeoutMs,
      );
      for (const signal of signals) signal.addEventListener("abort", onAbort, { once: true });
      if (signals.some((signal) => signal.aborted)) onAbort();
      const readers = [readOutput(), readErrors()];
      try {
        return await result;
      } finally {
        await Promise.allSettled(readers);
      }
    },
  };
}
