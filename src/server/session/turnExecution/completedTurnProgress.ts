import { isDeepStrictEqual } from "node:util";

import {
  piTurnMessagesToModelMessages,
  toolResultContentFromOutput,
} from "../../../runtime/piMessageBridge";
import { RUNTIME_COMMITTED_PROGRESS } from "../../../runtime/types";
import type { ModelMessage } from "../../../types";

type RecordValue = Record<string, unknown>;
type ToolIdentity = { id: string; name: string; key: string };
type ObservedTool = ToolIdentity & {
  step: number;
  input?: unknown;
  excluded: boolean;
  result?: ModelMessage;
};
type SourceResult = { message: ModelMessage; part: RecordValue; index: number };
type SourceCall = ToolIdentity & {
  part: RecordValue;
  input?: unknown;
  proof?: ObservedTool;
  result?: SourceResult;
};
type SourceGroup = { message: ModelMessage; content: unknown[]; calls: SourceCall[] };

function asRecord(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function identity(part: RecordValue): ToolIdentity | undefined {
  const id = nonEmptyString(part.toolCallId) ?? nonEmptyString(part.id);
  const name = nonEmptyString(part.toolName) ?? nonEmptyString(part.name);
  return id && name ? { id, name, key: JSON.stringify([id, name]) } : undefined;
}

function snapshotInput(value: unknown, allowRawInput: boolean): unknown {
  if (value === undefined || (!allowRawInput && !asRecord(value))) return undefined;
  try {
    return structuredClone(value);
  } catch {
    return undefined;
  }
}

function resultMessage(tool: ToolIdentity, output: unknown, isError: boolean): ModelMessage {
  const [message] = piTurnMessagesToModelMessages([
    {
      role: "toolResult",
      toolCallId: tool.id,
      toolName: tool.name,
      content: toolResultContentFromOutput(output),
      isError,
    },
  ]);
  const part = asRecord(Array.isArray(message?.content) ? message.content[0] : undefined);
  if (!message || !part) throw new Error("Tool result conversion did not produce a message.");
  return structuredClone({
    ...message,
    content: [{ ...part, toolCallId: tool.id, toolName: tool.name }],
  });
}

function sourceGroups(
  messages: readonly ModelMessage[],
  allowProviderExecuted: boolean,
): SourceGroup[] {
  const groups: SourceGroup[] = [];
  const pending = new Map<string, SourceCall[]>();
  for (const [index, message] of messages.entries()) {
    if (!Array.isArray(message.content)) continue;
    if (message.role === "assistant") {
      const group: SourceGroup = { message, content: message.content, calls: [] };
      for (const value of message.content) {
        const part = asRecord(value);
        if (
          !part ||
          (part.type !== "tool-call" && part.type !== "toolCall") ||
          (!allowProviderExecuted &&
            (part.providerExecuted === true || message.providerExecuted === true))
        ) {
          continue;
        }
        const tool = identity(part);
        if (!tool) continue;
        const call: SourceCall = {
          ...tool,
          part,
          input: snapshotInput(
            part.input !== undefined ? part.input : part.arguments,
            allowProviderExecuted,
          ),
        };
        group.calls.push(call);
        const queue = pending.get(tool.key) ?? [];
        queue.push(call);
        pending.set(tool.key, queue);
      }
      groups.push(group);
    } else if (message.role === "tool") {
      for (const value of message.content) {
        const part = asRecord(value);
        if (
          !part ||
          (part.type !== "tool-result" && part.type !== "toolResult") ||
          (!allowProviderExecuted && part.providerExecuted === true)
        ) {
          continue;
        }
        const tool = identity(part);
        if (!tool) continue;
        const call = pending.get(tool.key)?.shift();
        if (call) call.result = { message, part, index };
      }
    }
  }
  return groups;
}

/** Records admission before cancellation; never derives completion from returned late output. */
export function createCompletedTurnProgressTracker(options?: { allowProviderExecuted?: boolean }) {
  const allowProviderExecuted = options?.allowProviderExecuted === true;
  const observed = new Map<string, ObservedTool[]>();
  const pending = new Map<string, ObservedTool[]>();
  const inOrder: ObservedTool[] = [];
  const completedSteps: Array<{ step: number; messages: ModelMessage[] }> = [];
  let step = 0;

  const remember = (tool: ObservedTool) => {
    const queue = observed.get(tool.key) ?? [];
    queue.push(tool);
    observed.set(tool.key, queue);
    inOrder.push(tool);
  };

  return {
    observe(value: unknown): void {
      const part = asRecord(value);
      if (!part || part.preliminary === true) return;
      if (part.type === "start-step") {
        step += 1;
        pending.clear();
        return;
      }
      const completedMessages = asRecord(
        (part as Record<PropertyKey, unknown>)[RUNTIME_COMMITTED_PROGRESS],
      )?.assistantMessages;
      if (Array.isArray(completedMessages)) {
        completedSteps.push({
          step,
          messages: structuredClone(
            completedMessages.filter((message) => asRecord(message)?.role === "assistant"),
          ),
        });
      }
      if (part.type !== "tool-call" && part.type !== "tool-result" && part.type !== "tool-error") {
        return;
      }
      const tool = identity(part);
      if (!tool) return;
      if (part.type === "tool-call") {
        const occurrence: ObservedTool = {
          ...tool,
          step,
          input: snapshotInput(part.input, allowProviderExecuted),
          excluded: !allowProviderExecuted && part.providerExecuted === true,
        };
        remember(occurrence);
        const queue = pending.get(tool.key) ?? [];
        queue.push(occurrence);
        pending.set(tool.key, queue);
        return;
      }

      let occurrence = pending.get(tool.key)?.shift();
      if (!occurrence) {
        const previous = observed.get(tool.key)?.at(-1);
        if (previous?.step === step) return;
        occurrence = {
          ...tool,
          step,
          excluded: !allowProviderExecuted && part.providerExecuted === true,
        };
        remember(occurrence);
      }
      occurrence.excluded ||= !allowProviderExecuted && part.providerExecuted === true;
      if (occurrence.excluded) return;
      const output = part.type === "tool-error" ? part.error : part.output;
      occurrence.result = resultMessage(
        tool,
        output instanceof Error ? output.message : output,
        part.type === "tool-error",
      );
    },

    retain(
      responseMessages: readonly ModelMessage[] | undefined,
      opts?: { allowEventOnlyFallback?: boolean },
    ): ModelMessage[] {
      const used = new Set<ObservedTool>();
      const positions = new Map(inOrder.map((tool, index) => [tool, index]));
      const retained: Array<{ position: number; messages: ModelMessage[] }> = [];
      const attachProofs = (groups: SourceGroup[], sourceStep?: number) => {
        const cursors = new Map<string, number>();
        for (const group of groups) {
          for (const call of group.calls) {
            const cursor = cursors.get(call.key) ?? 0;
            const occurrences = observed.get(call.key);
            const proof =
              sourceStep === undefined
                ? occurrences?.[cursor]
                : occurrences?.filter((tool) => tool.step === sourceStep)[cursor];
            cursors.set(call.key, cursor + 1);
            if (
              proof?.result &&
              !proof.excluded &&
              call.input !== undefined &&
              (proof.input === undefined || isDeepStrictEqual(proof.input, call.input))
            ) {
              call.proof = proof;
            }
          }
        }
      };
      const finalGroups = sourceGroups(responseMessages ?? [], allowProviderExecuted);
      attachProofs(finalGroups);
      const sourceResults = new Map<ObservedTool, SourceResult>();
      for (const group of finalGroups) {
        for (const call of group.calls) {
          if (call.proof && call.result) sourceResults.set(call.proof, call.result);
        }
      }
      const capturedGroups = completedSteps.flatMap((completedStep) => {
        const groups = sourceGroups(completedStep.messages, allowProviderExecuted);
        attachProofs(groups, completedStep.step);
        for (const group of groups) {
          for (const call of group.calls) {
            if (call.proof) call.result = sourceResults.get(call.proof);
          }
        }
        return groups;
      });
      const candidates = [
        ...capturedGroups.map((group) => ({ group, preserveAssistant: true })),
        ...finalGroups.map((group) => ({ group, preserveAssistant: false })),
      ];
      for (const { group, preserveAssistant } of candidates) {
        const completed = group.calls.filter((call) => call.proof && !used.has(call.proof));
        if (completed.length === 0) continue;
        let position = Number.MAX_SAFE_INTEGER;
        for (const call of completed) {
          if (!call.proof) continue;
          used.add(call.proof);
          position = Math.min(position, positions.get(call.proof) ?? position);
        }
        const selected = new Set(completed.map((call) => call.part));
        const messages: ModelMessage[] = [
          preserveAssistant
            ? {
                ...group.message,
                content: group.content.filter((value) => {
                  const part = asRecord(value);
                  return (
                    part &&
                    (selected.has(part) ||
                      part.type === "text" ||
                      part.type === "reasoning" ||
                      part.type === "thinking")
                  );
                }),
              }
            : {
                role: "assistant",
                content: completed.map((call) => ({
                  type: "tool-call",
                  toolCallId: call.id,
                  toolName: call.name,
                  input: call.proof?.input !== undefined ? call.proof.input : call.input,
                })),
              },
        ];

        completed.sort(
          (left, right) =>
            (left.result?.index ?? Number.MAX_SAFE_INTEGER) -
            (right.result?.index ?? Number.MAX_SAFE_INTEGER),
        );
        for (const call of completed) {
          const captured = call.proof?.result;
          if (!captured) continue;
          const source = call.result;
          if (
            source &&
            isDeepStrictEqual(
              resultMessage(
                call,
                source.part.output ?? source.part.content,
                source.part.isError === true,
              ),
              captured,
            )
          ) {
            messages.push({ ...source.message, content: [source.part] });
          } else {
            messages.push(captured);
          }
        }
        retained.push({ position, messages });
      }

      if (opts?.allowEventOnlyFallback) {
        for (const tool of inOrder) {
          if (!tool.result || tool.input === undefined || tool.excluded || used.has(tool)) continue;
          retained.push({
            position: positions.get(tool) ?? Number.MAX_SAFE_INTEGER,
            messages: [
              {
                role: "assistant",
                content: [
                  {
                    type: "tool-call",
                    toolCallId: tool.id,
                    toolName: tool.name,
                    input: tool.input,
                  },
                ],
              },
              tool.result,
            ],
          });
        }
      }
      retained.sort((left, right) => left.position - right.position);
      return structuredClone(retained.flatMap((entry) => entry.messages));
    },
  };
}
