import { buildRuntimeTelemetrySettings } from "../../observability/runtime";
import { loadAgentPrompt } from "../../prompt";
import { buildGooglePrepareStep } from "../../providers/googleReplay";
import { createRuntime } from "../../runtime";
import { createTools } from "../../tools";
import type { ToolContext } from "../../tools";
import type { AgentConfig } from "../../types";
import type { AgentReasoningEffort, AgentRole } from "../../shared/agents";

import { routeAgentConfig } from "./modelRouter";
import { getAgentRoleDefinition } from "./roles";
import { filterToolsForRole } from "./toolPolicy";

export class DelegateRunner {
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
    model?: string;
    reasoningEffort?: AgentReasoningEffort;
  }): Promise<string> {
    const roleDefinition = getAgentRoleDefinition(opts.role);
    const routed = routeAgentConfig(opts.config, {
      role: roleDefinition,
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.reasoningEffort ? { reasoningEffort: opts.reasoningEffort } : {}),
    });
    const system = await loadAgentPrompt(routed.config, opts.role);
    const delegateContext: ToolContext = {
      config: routed.config,
      log: (line) => opts.log(`[delegate:${opts.role}] ${line}`),
      askUser: opts.askUser,
      approveCommand: opts.approveCommand,
      spawnDepth: (opts.spawnDepth ?? 0) + 1,
      abortSignal: opts.abortSignal,
      availableSkills: opts.discoveredSkills,
      turnUserPrompt: opts.message,
      agentRole: opts.role,
    };
    const tools = filterToolsForRole(createTools(delegateContext), roleDefinition);
    const googlePrepareStep =
      routed.config.provider === "google" && Object.keys(tools).length > 0
        ? buildGooglePrepareStep(routed.config.providerOptions, delegateContext.log)
        : undefined;
    const telemetry = await buildRuntimeTelemetrySettings(routed.config, {
      functionId: "agent.delegate",
      metadata: {
        role: opts.role,
        model: routed.effectiveModel,
      },
    });

    const runtime = createRuntime(routed.config);
    const result = await runtime.runTurn({
      config: routed.config,
      system,
      messages: [{ role: "user", content: opts.message }] as any,
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
    return result.text;
  }
}
