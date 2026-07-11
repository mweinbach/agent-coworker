import { sameToolInputDigest, type ToolInputDigest } from "./toolInputDigest";
import { digestToolInput } from "./toolInputDigestHasher";
import type { ToolRetryIntent } from "./toolRetry";

export type ToolCallMetadata = {
  inputDigest: ToolInputDigest;
  retryOf?: string;
};

type ToolAttempt = {
  name: string;
  inputText: string;
  metadata?: ToolCallMetadata;
  terminal: boolean;
};

export type ToolRetryAttemptTracker = {
  start(key: string, name: string): void;
  appendInput(key: string, delta: string): void;
  finalize(key: string, name: string, args: unknown): ToolCallMetadata | null;
  finalizeBuffered(key: string, name: string): ToolCallMetadata | null;
  complete(key: string, successful: boolean): void;
};

function parseCompleteInput(inputText: string): unknown | undefined {
  if (!inputText) return {};
  try {
    return JSON.parse(inputText) as unknown;
  } catch {
    return undefined;
  }
}

export function createToolRetryAttemptTracker(intent?: ToolRetryIntent): ToolRetryAttemptTracker {
  const targets = [...(intent?.targets ?? [])];
  const resolvedTargetIds = new Set<string>();
  const attemptByKey = new Map<string, ToolAttempt>();

  const activeAttempt = (key: string, name: string): ToolAttempt => {
    const existing = attemptByKey.get(key);
    if (existing && !existing.terminal) {
      if (name && (existing.name === "" || name !== "tool")) existing.name = name;
      return existing;
    }
    const next: ToolAttempt = {
      name,
      inputText: "",
      terminal: false,
    };
    attemptByKey.set(key, next);
    return next;
  };

  const finalize = (key: string, name: string, args: unknown): ToolCallMetadata | null => {
    const attempt = activeAttempt(key, name);
    const inputDigest = digestToolInput(name, args);
    if (!inputDigest) return null;
    const target = targets.find(
      (candidate) =>
        !resolvedTargetIds.has(candidate.itemId) &&
        sameToolInputDigest(candidate.inputDigest, inputDigest),
    );
    const metadata: ToolCallMetadata = {
      inputDigest,
      ...(target ? { retryOf: target.itemId } : {}),
    };
    attempt.metadata = metadata;
    return metadata;
  };

  return {
    start(key, name) {
      activeAttempt(key, name);
    },
    appendInput(key, delta) {
      const attempt = activeAttempt(key, "");
      attempt.inputText = `${attempt.inputText}${delta}`;
    },
    finalize,
    finalizeBuffered(key, name) {
      const attempt = activeAttempt(key, name);
      const args = parseCompleteInput(attempt.inputText);
      const resolvedName = name && name !== "tool" ? name : attempt.name || name;
      return args === undefined ? null : finalize(key, resolvedName, args);
    },
    complete(key, successful) {
      const attempt = attemptByKey.get(key);
      if (!attempt) return;
      attempt.terminal = true;
      if (successful && attempt.metadata?.retryOf) {
        resolvedTargetIds.add(attempt.metadata.retryOf);
      }
    },
  };
}
