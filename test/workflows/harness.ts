import fs from "node:fs/promises";
import path from "node:path";

import { scratchRoots } from "../../src/platform/sandbox";
import type { AgentControl, ToolContext } from "../../src/tools/context";

export async function workflowTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(scratchRoots()[0] ?? "/tmp", "cowork-workflows-test-"));
}

export type FakeAgent = {
  /** Final assistant text this child produces, by call order (1-based). */
  reply?: (nth: number, message: string) => string;
  /** Execution state reported by wait(), by call order. Defaults to "completed". */
  state?: (nth: number) => "completed" | "errored" | "closed";
  costUsd?: number;
};

export type FakeControl = AgentControl & {
  spawnCount: () => number;
  messages: () => string[];
  models: () => Array<string | undefined>;
  closed: () => string[];
};

/**
 * Minimal in-memory `AgentControl` good enough to drive `runWorkflow` without a
 * session, a provider, or the network.
 */
export function makeFakeControl(opts: FakeAgent = {}): FakeControl {
  let spawns = 0;
  const texts = new Map<string, string>();
  const order = new Map<string, number>();
  const messages: string[] = [];
  const models: Array<string | undefined> = [];
  const closed: string[] = [];

  const control = {
    spawn: async ({ message, model }: { message: string; model?: string }) => {
      const nth = ++spawns;
      const agentId = `agent-${nth}`;
      order.set(agentId, nth);
      messages.push(message);
      models.push(model);
      texts.set(agentId, opts.reply ? opts.reply(nth, message) : `reply ${nth}`);
      return {
        agentId,
        parentSessionId: "root",
        role: "default",
        mode: "collaborative",
        depth: 1,
        effectiveModel: "test-model",
        provider: "openai",
        title: agentId,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        lifecycleState: "active",
        executionState: "running",
        busy: true,
      } as never;
    },
    wait: async ({ agentIds }: { agentIds: string[] }) => {
      const agentId = agentIds[0] as string;
      const nth = order.get(agentId) ?? 1;
      const executionState = opts.state ? opts.state(nth) : "completed";
      return {
        timedOut: false,
        mode: "all" as const,
        agents: [{ agentId, executionState } as never],
        readyAgentIds: agentIds,
        inspections: [{ agentId, latestAssistantText: texts.get(agentId) ?? "" }],
      };
    },
    sendInput: async ({ agentId, message }: { agentId: string; message: string }) => {
      messages.push(message);
      // A repair turn replaces the child's final message.
      const nth = order.get(agentId) ?? 1;
      texts.set(agentId, opts.reply ? opts.reply(nth, message) : `reply ${nth}`);
    },
    inspect: async () =>
      ({
        sessionUsage: { estimatedTotalCostUsd: opts.costUsd ?? 0.01 },
      }) as never,
    close: async ({ agentId }: { agentId: string }) => {
      closed.push(agentId);
      return {} as never;
    },
    list: async () => [],
    resume: async () => ({}) as never,
  } as unknown as FakeControl;

  control.spawnCount = () => spawns;
  control.messages = () => messages;
  control.models = () => models;
  control.closed = () => closed;
  return control;
}

export function makeWorkflowCtx(
  projectCoworkDir: string,
  overrides: Partial<ToolContext> = {},
): ToolContext {
  return {
    config: { projectCoworkDir, workflowsEnabled: true } as ToolContext["config"],
    log: () => {},
    askUser: async () => "",
    approveCommand: async () => true,
    ...overrides,
  } as ToolContext;
}

export function metaHeader(name = "test", phases: string[] = ["main"]): string {
  return `export const meta = ${JSON.stringify({
    name,
    description: "a test workflow",
    phases,
  })};\n`;
}
