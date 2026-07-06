import path from "node:path";

import { loadMCPServers, loadMCPTools } from "../../mcp";
import { buildRuntimeTelemetrySettings } from "../../observability/runtime";
import { resolveSandboxPolicy } from "../../platform/sandbox";
import { loadAgentPrompt } from "../../prompt";
import { buildGooglePrepareStep } from "../../providers/googleReplay";
import { createRuntime } from "../../runtime";
import type { AgentReasoningEffort, AgentRole } from "../../shared/agents";
import type { ToolContext } from "../../tools";
import { createTools, filterToolsForCodexDynamicBoundary } from "../../tools";
import { buildTurnSystemPrompt } from "../../turnSystemPrompt";
import type {
  AgentConfig,
  HarnessContextState,
  ModelMessage,
  ProviderName,
  TodoItem,
} from "../../types";

import { routeAgentConfig } from "./modelRouter";
import { getAgentRoleDefinition, getAgentRoleShellPolicy } from "./roles";
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
  loadMCPServers?: typeof loadMCPServers;
  loadMCPTools?: typeof loadMCPTools;
};

const defaultDelegateRunnerDeps: DelegateRunnerDeps = {
  loadAgentPrompt,
  buildRuntimeTelemetrySettings,
  buildGooglePrepareStep,
  createRuntime,
  createTools,
  loadMCPServers,
  loadMCPTools,
};

function providerOwnsExecutableTools(config: AgentConfig): boolean {
  return config.provider === "codex-cli";
}

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
    initialTodos?: TodoItem[];
    harnessContext?: HarnessContextState | null;
    targetPaths?: readonly string[] | null;
    updateTodos?: ToolContext["updateTodos"];
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
      routed.config,
      [],
      opts.harnessContext,
    );
    const shellPolicy = getAgentRoleShellPolicy(opts.role);
    const delegateContext: ToolContext = {
      config: routed.config,
      log: (line) => opts.log(`[delegate:${opts.role}] ${line}`),
      askUser: opts.askUser,
      approveCommand: opts.approveCommand,
      updateTodos: opts.updateTodos,
      spawnDepth: (opts.spawnDepth ?? 0) + 1,
      abortSignal: opts.abortSignal,
      availableSkills: opts.discoveredSkills,
      turnUserPrompt: opts.message,
      harnessContext: opts.harnessContext,
      agentRole: opts.role,
      agentTargetPaths: opts.targetPaths,
      shellPolicy,
      sandboxPolicy: resolveSandboxPolicy({
        config: routed.config.sandbox,
        readOnlyRole: roleDefinition.readOnly || shellPolicy === "no_project_write",
        workingDirectory: routed.config.workingDirectory,
        projectRoot: path.dirname(routed.config.projectCoworkDir),
        outputDirectory: routed.config.outputDirectory,
        uploadsDirectory: routed.config.uploadsDirectory,
        targetPaths: opts.targetPaths,
      }),
    };
    let closeMcp: undefined | (() => Promise<void>);
    let mcpTools: Record<string, any> = {};
    if (routed.config.enableMcp === true) {
      const loadMCPServersFn = this.deps.loadMCPServers ?? loadMCPServers;
      const loadMCPToolsFn = this.deps.loadMCPTools ?? loadMCPTools;
      const servers = await loadMCPServersFn(routed.config, { log: delegateContext.log });
      if (servers.length > 0) {
        const loaded = await loadMCPToolsFn(servers, { log: delegateContext.log });
        mcpTools = loaded.tools;
        closeMcp = loaded.close;
        for (const error of loaded.errors) {
          delegateContext.log(error);
        }
      }
    }
    const rawTools = filterToolsForRole(
      { ...this.deps.createTools(delegateContext), ...mcpTools },
      roleDefinition,
      { allowProfileMcp: true },
    );
    const tools = providerOwnsExecutableTools(routed.config)
      ? filterToolsForCodexDynamicBoundary(rawTools)
      : rawTools;
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

    if (opts.initialTodos && opts.updateTodos) {
      opts.updateTodos(structuredClone(opts.initialTodos));
    }

    const runtime = this.deps.createRuntime(routed.config);
    const result = await (async () => {
      try {
        return await runtime.runTurn({
          config: routed.config,
          system,
          messages: [
            ...(opts.seedMessages ? structuredClone(opts.seedMessages) : []),
            { role: "user", content: opts.message },
          ] as any,
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
          // Forward the child's scope + shell policy so provider runtimes (e.g. the
          // Codex app-server) constrain native FS/shell tools the same way the
          // built-in tools are: scoped to targetPaths and read-only for read-only roles.
          agentTargetPaths: delegateContext.agentTargetPaths,
          shellPolicy: delegateContext.shellPolicy,
          ...(telemetry
            ? { telemetryContext: { functionId: "agent.delegate", metadata: { role: opts.role } } }
            : {}),
          ...(googlePrepareStep ? { prepareStep: googlePrepareStep } : {}),
        } as any);
      } finally {
        try {
          await closeMcp?.();
        } catch (error) {
          delegateContext.log(`[MCP] Error closing MCP connections: ${String(error)}`);
        }
      }
    })();
    return {
      text: result.text,
      responseMessages: structuredClone(result.responseMessages),
    };
  }
}
