import type { RunSpec } from "./rawLoopScenarios";

/** A single traced harness step: a tool call, its result, or a nested payload. */
export type TracedStep = {
  scope: string;
  step: unknown;
};

type RawLoopToolDefinition = {
  description?: unknown;
  inputSchema?: unknown;
  execute?: (input: unknown) => Promise<unknown> | unknown;
};

export type PrerequisiteToolGuardConfig = {
  requiredToolName?: string;
  guardedToolNames?: string[];
};

function toolExecute(
  tool: RawLoopToolDefinition | undefined,
): ((input: unknown) => Promise<unknown> | unknown) | undefined {
  const execute = tool?.execute;
  return typeof execute === "function" ? execute : undefined;
}

function observeTool(
  tool: RawLoopToolDefinition | undefined,
  onSuccess: (input: unknown, output: unknown) => void,
): RawLoopToolDefinition | undefined {
  const execute = toolExecute(tool);
  if (tool === undefined || execute === undefined) return tool;
  return {
    ...tool,
    execute: async (input: unknown) => {
      const output = await execute(input);
      onSuccess(input, output);
      return output;
    },
  };
}

function gateTool(
  tool: RawLoopToolDefinition | undefined,
  shouldBlock: () => boolean,
  errorMessage: string,
): RawLoopToolDefinition | undefined {
  const execute = toolExecute(tool);
  if (tool === undefined || execute === undefined) return tool;
  return {
    ...tool,
    execute: async (input: unknown) => {
      if (shouldBlock()) {
        throw new Error(errorMessage);
      }
      return await execute(input);
    },
  };
}

function collectToolCallsFromUnknown(value: unknown, sink: string[]): void {
  if (!value) return;
  if (Array.isArray(value)) {
    for (const item of value) {
      collectToolCallsFromUnknown(item, sink);
    }
    return;
  }
  if (typeof value !== "object") return;

  const record = value as Record<string, unknown>;
  if (record.type === "tool-call" && typeof record.toolName === "string") {
    sink.push(record.toolName);
  }

  for (const nested of Object.values(record)) {
    collectToolCallsFromUnknown(nested, sink);
  }
}

function collectTracedToolCallNames(steps: TracedStep[]): string[] {
  const names: string[] = [];
  for (const step of steps) {
    collectToolCallsFromUnknown(step.step, names);
  }
  return names;
}

function collectToolCallNamesFromToolLog(toolLogLines: string[]): string[] {
  const names: string[] = [];
  for (const line of toolLogLines) {
    const match = /^tool>\s+([a-zA-Z0-9_]+)/.exec(line);
    if (match?.[1]) names.push(match[1]);
  }
  return names;
}

export function assertRawLoopToolRequirements(
  run: Pick<RunSpec, "requiredToolCalls">,
  steps: TracedStep[],
  toolLogLines: string[],
): void {
  const requiredToolCalls = run.requiredToolCalls;
  if (!Array.isArray(requiredToolCalls) || requiredToolCalls.length === 0) return;

  const tracedToolCalls = collectTracedToolCallNames(steps);
  const loggedToolCalls = collectToolCallNamesFromToolLog(toolLogLines);
  const missing = requiredToolCalls.filter((toolName) => {
    if (loggedToolCalls.includes(toolName)) return false;
    return !tracedToolCalls.includes(toolName);
  });
  if (missing.length > 0) {
    throw new Error(`Missing required tool call(s): ${missing.join(", ")}`);
  }
}

/**
 * Mirrors the Rust `is_failed_tool_outcome` classification: an errored or denied item, or a
 * result that reports `denied`, `ok: false` or an `error`, did not take effect.
 */
export function isFailedRawLoopToolOutcome(
  toolName: string,
  state: string | undefined,
  output: unknown,
): boolean {
  if (state === "output-error" || state === "output-denied") return true;
  if (output !== null && typeof output === "object" && !Array.isArray(output)) {
    const record = output as Record<string, unknown>;
    return record.denied === true || record.ok === false || Object.hasOwn(record, "error");
  }
  if (typeof output === "string") {
    return toolName.toLowerCase() === "skill" && output.toLowerCase().includes("not found");
  }
  return false;
}

type ObservedToolCall = { toolName: string; failed: boolean };

function toolStepRecord(value: unknown, type: string): Record<string, unknown> | null {
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  return record.type === type && typeof record.toolName === "string" ? record : null;
}

/** Top-level tool calls in trace order, each paired with the result step that follows it. */
function collectObservedToolCalls(steps: TracedStep[]): ObservedToolCall[] {
  const calls: ObservedToolCall[] = [];
  for (const [index, entry] of steps.entries()) {
    const call = toolStepRecord(entry.step, "tool-call");
    if (call === null) continue;
    const toolName = call.toolName as string;
    const result = toolStepRecord(steps[index + 1]?.step, "tool-result");
    const failed =
      result !== null && result.toolName === toolName
        ? isFailedRawLoopToolOutcome(
            toolName,
            typeof result.state === "string" ? result.state : undefined,
            result.output,
          )
        : false;
    calls.push({ toolName, failed });
  }
  return calls;
}

/**
 * Enforces `requiredToolBeforeTools` / `guardedToolsBeforeRequiredTool` on a finished trace:
 * no guarded tool may take effect before the required tool has succeeded. The in-process
 * runner blocked such calls at dispatch; the server-driven runner rejects the trace instead.
 * A guarded call that itself failed had no effect and is not a violation, matching the old
 * dispatch gate (whose blocked calls surfaced as failed tool calls).
 */
export function assertRawLoopToolOrder(
  run: Pick<RunSpec, "requiredToolBeforeTools" | "guardedToolsBeforeRequiredTool">,
  steps: TracedStep[],
): void {
  const requiredTool = run.requiredToolBeforeTools;
  const guardedToolNames = (run.guardedToolsBeforeRequiredTool ?? []).filter(
    (name) => name !== requiredTool,
  );
  if (!requiredTool || guardedToolNames.length === 0) return;

  let requiredSucceeded = false;
  for (const call of collectObservedToolCalls(steps)) {
    if (call.toolName === requiredTool) {
      if (!call.failed) requiredSucceeded = true;
      continue;
    }
    if (!requiredSucceeded && !call.failed && guardedToolNames.includes(call.toolName)) {
      throw new Error(
        `Tool order violation: "${requiredTool}" must succeed before "${call.toolName}", but "${call.toolName}" ran first.`,
      );
    }
  }
}

export function summarizeRawLoopBudgets(toolCallNames: string[]) {
  return {
    toolCalls: toolCallNames.length,
    bashCalls: toolCallNames.filter((name) => name === "bash").length,
    webCalls: toolCallNames.filter((name) => name === "webSearch" || name === "webFetch").length,
    spawnedAgents: toolCallNames.filter((name) => name === "spawnAgent").length,
  };
}

export function countObservedLoopSteps(stepNumbers: number[]): number {
  if (stepNumbers.length === 0) return 0;
  return Math.max(...stepNumbers);
}

export function buildRawLoopBudgetSummary(
  toolLogLines: string[],
  totalSteps: number,
  repairPassCount: number,
) {
  return {
    ...summarizeRawLoopBudgets(collectToolCallNamesFromToolLog(toolLogLines)),
    totalSteps,
    repairPassCount,
  };
}

export function wrapToolsWithTracing(
  baseTools: Record<string, RawLoopToolDefinition | undefined>,
  steps: TracedStep[],
  prerequisiteToolGuard?: PrerequisiteToolGuardConfig,
): Record<string, RawLoopToolDefinition> {
  const tools: Record<string, RawLoopToolDefinition | undefined> = { ...baseTools };

  for (const [toolName, toolDef] of Object.entries(tools)) {
    tools[toolName] = observeTool(toolDef, (input, output) => {
      steps.push({ scope: "tool-call", step: { type: "tool-call", toolName, input } });
      steps.push({ scope: "tool-result", step: { type: "tool-result", toolName, output } });
    });
  }

  const requiredTool = prerequisiteToolGuard?.requiredToolName;
  const guardedToolNames = prerequisiteToolGuard?.guardedToolNames;
  if (requiredTool && guardedToolNames && guardedToolNames.length > 0) {
    let requiredCalled = false;
    tools[requiredTool] = observeTool(tools[requiredTool], () => {
      requiredCalled = true;
    });
    for (const guardedName of guardedToolNames) {
      if (guardedName === requiredTool) continue;
      tools[guardedName] = gateTool(
        tools[guardedName],
        () => !requiredCalled,
        `Tool "${requiredTool}" must be called before "${guardedName}".`,
      );
    }
  }

  return Object.fromEntries(
    Object.entries(tools).filter((entry): entry is [string, RawLoopToolDefinition] =>
      Boolean(entry[1]),
    ),
  );
}
