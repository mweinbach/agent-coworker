import { buildRuntimeTelemetrySettings } from "../../observability/runtime";
import { loadAgentPrompt } from "../../prompt";
import { buildGooglePrepareStep } from "../../providers/googleReplay";
import { createRuntime } from "../../runtime";
import { createTools } from "../../tools";
import type { ToolContext } from "../../tools";
import { buildTurnSystemPrompt } from "../../harness/buildTurnSystemPrompt";
import type { ModelMessage } from "../../types";
import type { AgentConfig, HarnessContextState, ProviderName } from "../../types";
import type { AgentReasoningEffort, AgentRole } from "../../shared/agents";

import { routeAgentConfig } from "./modelRouter";
import { getAgentRoleDefinition } from "./roles";
import { filterToolsForRole } from "./toolPolicy";

export type DelegateRunResult = {
  text: string;
  responseMessages: ModelMessage[];
};

type DelegateRunnerDeps = {
  loadAgentPrompt: typeof loadAgentPrompt;
  buildRuntimeTelemetrySettings: typeof buildRuntimeTelemetrySettings;
  buildGooglePrepareStep: typeof buildGooglePrepareStep;
  createRuntime: typeof createRuntime;
  createTools: typeof createTools;
};

const defaultDelegateRunnerDeps: DelegateRunnerDeps = {
  loadAgentPrompt,
  buildRuntimeTelemetrySettings,
  buildGooglePrepareStep,
  createRuntime,
  createTools,
};

export class DelegateRunner {
  constructor(private readonly deps: DelegateRunnerDeps = defaultDelegateRunnerDeps) {}

  async run(opts: {
    config: AgentConfig;
    role: AgentRole;
    message: string;
    spawnDepth?: number;
    log: (line: string) => void;
    askUser: ToolContext["askUser"];
    approveCommand: ToolContext["approveCommand"];
    abortSignal?: AbortSignal;
    discoveredSkills?: ToolContext["availableSkills"];
    seedMessages?: ModelMessage[];
    harnessContext?: HarnessContextState | null;
    model?: string;
    reasoningEffort?: AgentReasoningEffort;
    connectedProviders?: readonly ProviderName[];
  }): Promise<DelegateRunResult> {
    const roleDefinition = getAgentRoleDefinition(opts.role);
    const routed = routeAgentConfig(opts.config, {
      role: roleDefinition,
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.reasoningEffort ? { reasoningEffort: opts.reasoningEffort } : {}),
      ...(opts.connectedProviders ? { connectedProviders: opts.connectedProviders } : {}),
    });
    if (routed.fallbackLine) {
      opts.log(`[delegate:${opts.role}] ${routed.fallbackLine}`);
    }
    const system = buildTurnSystemPrompt(
      await this.deps.loadAgentPrompt(routed.config, opts.role),
      [],
      opts.harnessContext,
    );
    const delegateContext: ToolContext = {
      config: routed.config,
      log: (line) => opts.log(`[delegate:${opts.role}] ${line}`),
      askUser: opts.askUser,
      approveCommand: opts.approveCommand,
      spawnDepth: (opts.spawnDepth ?? 0) + 1,
      abortSignal: opts.abortSignal,
      availableSkills: opts.discoveredSkills,
      turnUserPrompt: opts.message,
      harnessContext: opts.harnessContext,
      agentRole: opts.role,
    };
    const tools = filterToolsForRole(this.deps.createTools(delegateContext), roleDefinition);
    const googlePrepareStep =
      routed.config.provider === "google" && Object.keys(tools).length > 0
        ? this.deps.buildGooglePrepareStep(routed.config.providerOptions, delegateContext.log)
        : undefined;
    const telemetry = await this.deps.buildRuntimeTelemetrySettings(routed.config, {
      functionId: "agent.delegate",
      metadata: {
        role: opts.role,
        model: routed.effectiveModel,
      },
    });

    const runtime = this.deps.createRuntime(routed.config);
    const result = await runtime.runTurn({
      config: routed.config,
      system,
      messages: [...(opts.seedMessages ? structuredClone(opts.seedMessages) : []), { role: "user", content: opts.message }] as any,
      tools,
      agentControl: undefined,
      spawnDepth: delegateContext.spawnDepth,
      abortSignal: opts.abortSignal,
      discoveredSkills: opts.discoveredSkills,
      maxSteps: routed.config.provider === "google" ? 40 : 50,
      providerOptions: routed.config.providerOptions,
      log: delegateContext.log,
      askUser: delegateContext.askUser,
      approveCommand: delegateContext.approveCommand,
      ...(telemetry ? { telemetryContext: { functionId: "agent.delegate", metadata: { role: opts.role } } } : {}),
      ...(googlePrepareStep ? { prepareStep: googlePrepareStep } : {}),
      enableMcp: routed.config.enableMcp,
    } as any);
    return {
      text: result.text,
      responseMessages: structuredClone(result.responseMessages),
    };
  }
}
