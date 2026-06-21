import path from "node:path";
import { z } from "zod";
import { formatUserInputDisplayText } from "../../../shared/attachments";
import type { ServerErrorCode, ServerErrorData, ServerErrorSource } from "../../../types";
import type { FileAttachment } from "../../jsonrpc/routes/shared";
import type { SessionContext } from "../SessionContext";

const errorWithCodeSchema = z.object({ code: z.unknown() }).passthrough();
const taskLockAbortErrorBrand = Symbol("taskLockAbortError");
const taskLockAbortSessionError = Symbol("taskLockAbortSessionError");

export type TaskLockAbortSessionError = {
  code: ServerErrorCode;
  source: ServerErrorSource;
  message: string;
  data?: ServerErrorData;
};

export type TaskLockAbortError = Error & {
  code: "ABORT_ERR";
  [taskLockAbortErrorBrand]: true;
  [taskLockAbortSessionError]?: TaskLockAbortSessionError;
};

export function makeTurnId(): string {
  return crypto.randomUUID();
}

export function resolveUserInputDisplayText(
  text: string,
  attachments?: readonly Pick<FileAttachment, "filename">[],
): string {
  return formatUserInputDisplayText(
    text,
    attachments
      ?.map((attachment) => path.basename(attachment.filename))
      .filter((fileName) => fileName && fileName !== "." && fileName !== ".."),
  );
}

export function isStartStepPart(part: unknown): boolean {
  return (
    typeof part === "object" && part !== null && (part as { type?: unknown }).type === "start-step"
  );
}

export function makeTaskLockAbortError(
  message = "Cancelled by task lock",
  sessionError?: TaskLockAbortSessionError,
): TaskLockAbortError {
  const error: TaskLockAbortError = Object.assign(new Error(message), {
    code: "ABORT_ERR" as const,
    [taskLockAbortErrorBrand]: true as const,
  });
  if (sessionError) {
    error[taskLockAbortSessionError] = sessionError;
  }
  return error;
}

export function isTaskLockAbortError(err: unknown): err is TaskLockAbortError {
  return (
    err instanceof Error &&
    (err as Partial<Record<typeof taskLockAbortErrorBrand, boolean>>)[taskLockAbortErrorBrand] ===
      true
  );
}

export function getTaskLockAbortSessionError(err: unknown): TaskLockAbortSessionError | null {
  return isTaskLockAbortError(err) ? (err[taskLockAbortSessionError] ?? null) : null;
}

export function isAbortLikeError(context: SessionContext, err: unknown): boolean {
  if (context.state.abortController?.signal.aborted) return true;
  if (err instanceof DOMException && err.name === "AbortError") return true;

  const parsedCode = errorWithCodeSchema.safeParse(err);
  const code = parsedCode.success ? parsedCode.data.code : undefined;
  if (code === "ABORT_ERR") return true;

  const msg = context.formatError(err).toLowerCase();
  return msg.includes("abort") || msg.includes("cancel");
}
