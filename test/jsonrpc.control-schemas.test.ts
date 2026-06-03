import { describe, expect, test } from "bun:test";
import {
  jsonRpcControlRequestSchemas as mobileJsonRpcControlRequestSchemas,
  jsonRpcControlResultSchemas as mobileJsonRpcControlResultSchemas,
} from "../apps/mobile/src/cowork-shared/jsonrpcControlSchemas";
import {
  jsonRpcAgentNotificationSchemas,
  jsonRpcAgentRequestSchemas,
  jsonRpcAgentResultSchemas,
} from "../src/server/jsonrpc/schema.agents";
import {
  jsonRpcControlRequestSchemas,
  jsonRpcControlResultSchemas,
} from "../src/shared/jsonrpcControlSchemas";

describe("shared JSON-RPC control schemas", () => {
  test("parses provider auth and status envelopes", () => {
    const authResult = jsonRpcControlResultSchemas["cowork/provider/auth/setApiKey"].parse({
      event: {
        type: "provider_auth_result",
        sessionId: "session-1",
        provider: "google",
        methodId: "api-key",
        ok: true,
        mode: "api_key",
        message: "Saved.",
      },
    });

    const statusResult = jsonRpcControlResultSchemas["cowork/provider/status/refresh"].parse({
      event: {
        type: "provider_status",
        sessionId: "session-1",
        providers: [
          {
            provider: "google",
            authorized: true,
            verified: true,
            mode: "oauth",
            account: {
              email: "user@example.com",
            },
            message: "Authorized",
            checkedAt: new Date(0).toISOString(),
            usage: {
              rateLimits: [
                {
                  limitName: "requests",
                  primaryWindow: {
                    usedPercent: 12,
                    windowSeconds: 60,
                  },
                },
              ],
            },
          },
        ],
      },
    });

    expect(authResult.event.ok).toBe(true);
    expect(statusResult.event.providers[0]?.usage?.rateLimits[0]?.limitName).toBe("requests");
  });

  test("parses MCP server envelopes", () => {
    const parsed = jsonRpcControlResultSchemas["cowork/mcp/servers/read"].parse({
      event: {
        type: "mcp_servers",
        sessionId: "session-1",
        servers: [
          {
            name: "docs",
            transport: {
              type: "stdio",
              command: "uvx",
              args: ["docs-mcp"],
            },
            auth: {
              type: "oauth",
              oauthMode: "code",
            },
            source: "workspace",
            inherited: false,
            authMode: "oauth_pending",
            authScope: "workspace",
            authMessage: "Waiting for callback",
          },
        ],
        legacy: {
          workspace: {
            path: "/tmp/project/.cowork/mcp-servers.json",
            exists: false,
          },
          user: {
            path: "/tmp/user/.cowork/mcp-servers.json",
            exists: false,
          },
        },
        files: [
          {
            source: "workspace",
            path: "/tmp/project/.cowork/mcp-servers.json",
            exists: true,
            editable: true,
            legacy: false,
            serverCount: 1,
          },
          {
            source: "plugin",
            path: "/tmp/project/.agents/plugins/figma-toolkit/.mcp.json",
            exists: true,
            editable: false,
            legacy: false,
            serverCount: 1,
            pluginId: "figma-toolkit",
            pluginName: "figma-toolkit",
            pluginDisplayName: "Figma Toolkit",
            pluginScope: "workspace",
          },
        ],
        warnings: ["oauth pending"],
      },
    });

    expect(parsed.event.servers[0]?.authMode).toBe("oauth_pending");
    expect(parsed.event.files[0]?.editable).toBe(true);
    expect(parsed.event.files[1]?.pluginId).toBe("figma-toolkit");
  });

  test("keeps mobile plugin catalog schema aligned for partial marketplace snapshots", () => {
    const event = {
      type: "plugins_catalog",
      sessionId: "session-1",
      catalog: {
        plugins: [],
        availablePlugins: [],
        warnings: [],
      },
      availablePluginsPartial: true,
    };

    const parsed = jsonRpcControlResultSchemas["cowork/plugins/catalog/read"].parse({ event });
    const mobileParsed = mobileJsonRpcControlResultSchemas["cowork/plugins/catalog/read"].parse({
      event,
    });

    expect(parsed.event.availablePluginsPartial).toBe(true);
    expect(mobileParsed.event.availablePluginsPartial).toBe(true);
  });

  test("parses OpenAI native connector envelopes", () => {
    const parsed = jsonRpcControlResultSchemas["cowork/connectors/openai-native/list"].parse({
      event: {
        type: "openai_native_connectors",
        sessionId: "session-1",
        connectors: [
          {
            id: "connector_gmail",
            name: "Gmail",
            description: "Read mail",
            isEnabled: true,
          },
        ],
        enabledConnectorIds: ["connector_gmail"],
        authenticated: true,
      },
    });

    expect(parsed.event.connectors[0]?.id).toBe("connector_gmail");
    expect(parsed.event.enabledConnectorIds).toEqual(["connector_gmail"]);
  });

  test("parses memory list envelopes", () => {
    const parsed = jsonRpcControlResultSchemas["cowork/memory/list"].parse({
      event: {
        type: "memory_list",
        sessionId: "session-1",
        memories: [
          {
            id: "hot",
            scope: "workspace",
            content: "Remember this",
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString(),
          },
        ],
      },
    });

    expect(parsed.event.memories[0]?.id).toBe("hot");
  });

  test("parses advanced memory request and result envelopes", () => {
    const request = jsonRpcControlRequestSchemas["cowork/memory/advanced/upsert"].parse({
      cwd: "/tmp/proj",
      folder: "proj",
      name: "rule",
      description: "a rule",
      type: "feedback",
      body: "always do X",
    });
    expect(request.name).toBe("rule");
    const generateRequest = jsonRpcControlRequestSchemas["cowork/memory/advanced/generate"].parse({
      cwd: "/tmp/proj",
      folder: "proj",
      threadId: "session-1",
    });
    expect(generateRequest.threadId).toBe("session-1");

    const parsed = jsonRpcControlResultSchemas["cowork/memory/advanced/list"].parse({
      event: {
        type: "advanced_memory_list",
        sessionId: "session-1",
        folder: "proj",
        folders: ["proj", "(chats)"],
        memories: [
          {
            slug: "rule",
            name: "rule",
            description: "a rule",
            type: "feedback",
            originSessionId: "session-1",
            body: "always do X",
            updatedAt: new Date(0).toISOString(),
          },
        ],
      },
    });
    expect(parsed.event.folder).toBe("proj");
    expect(parsed.event.memories[0]?.slug).toBe("rule");
  });

  test("keeps mobile advanced memory schemas aligned", () => {
    const request = {
      cwd: "/tmp/proj",
      folder: "proj",
      name: "rule",
      description: "a rule",
      type: "feedback",
      body: "always do X",
    };
    const event = {
      type: "advanced_memory_list",
      sessionId: "session-1",
      folder: "proj",
      folders: ["proj", "(chats)"],
      memories: [
        {
          slug: "rule",
          name: "rule",
          description: "a rule",
          type: "feedback",
          originSessionId: "session-1",
          body: "always do X",
          updatedAt: new Date(0).toISOString(),
        },
      ],
    };

    const parsed = jsonRpcControlRequestSchemas["cowork/memory/advanced/upsert"].parse(request);
    const mobileParsed =
      mobileJsonRpcControlRequestSchemas["cowork/memory/advanced/upsert"].parse(request);
    const generateRequest = {
      cwd: "/tmp/proj",
      folder: "proj",
      threadId: "session-1",
    };
    const parsedGenerate =
      jsonRpcControlRequestSchemas["cowork/memory/advanced/generate"].parse(generateRequest);
    const mobileParsedGenerate =
      mobileJsonRpcControlRequestSchemas["cowork/memory/advanced/generate"].parse(generateRequest);
    const result = jsonRpcControlResultSchemas["cowork/memory/advanced/list"].parse({ event });
    const mobileResult = mobileJsonRpcControlResultSchemas["cowork/memory/advanced/list"].parse({
      event,
    });

    expect(mobileParsed).toEqual(parsed);
    expect(mobileParsedGenerate).toEqual(parsedGenerate);
    expect(mobileResult.event.memories[0]?.slug).toBe(result.event.memories[0]?.slug);
  });

  test("keeps mobile session default memory config schemas aligned", () => {
    const request = {
      cwd: "/tmp/proj",
      config: {
        advancedMemory: true,
        memoryGenerationModel: "gpt-5.4",
        clearMemoryGenerationModel: false,
      },
    };
    const event = {
      type: "session_config",
      sessionId: "session-1",
      config: {
        advancedMemory: true,
        memoryGenerationModel: "gpt-5.4",
      },
    };

    const parsed = jsonRpcControlRequestSchemas["cowork/session/defaults/apply"].parse(request);
    const mobileParsed =
      mobileJsonRpcControlRequestSchemas["cowork/session/defaults/apply"].parse(request);
    const result = jsonRpcControlResultSchemas["cowork/session/defaults/apply"].parse({ event });
    const mobileResult = mobileJsonRpcControlResultSchemas["cowork/session/defaults/apply"].parse({
      event,
    });

    expect(mobileParsed).toEqual(parsed);
    expect(mobileResult.event.config.advancedMemory).toBe(result.event.config.advancedMemory);
    expect(mobileResult.event.config.memoryGenerationModel).toBe(
      result.event.config.memoryGenerationModel,
    );
  });

  test("parses workspace backup envelopes", () => {
    const parsed = jsonRpcControlResultSchemas["cowork/backups/workspace/read"].parse({
      event: {
        type: "workspace_backups",
        sessionId: "session-1",
        workspacePath: "/tmp/project",
        backups: [
          {
            targetSessionId: "session-1",
            title: "Main session",
            provider: "google",
            model: "gemini-2.5-pro",
            lifecycle: "active",
            status: "ready",
            workingDirectory: "/tmp/project",
            backupDirectory: "/tmp/project/.cowork/backups/session-1",
            originalSnapshotKind: "directory",
            originalSnapshotBytes: 100,
            checkpointBytesTotal: 20,
            totalBytes: 120,
            checkpoints: [
              {
                id: "cp-1",
                index: 1,
                createdAt: new Date(0).toISOString(),
                trigger: "manual",
                changed: true,
                patchBytes: 20,
              },
            ],
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString(),
          },
        ],
      },
    });

    expect(parsed.event.backups[0]?.checkpoints[0]?.index).toBe(1);
  });

  test("parses session state and defaults apply envelopes", () => {
    const request = jsonRpcControlRequestSchemas["cowork/session/defaults/apply"].parse({
      cwd: "/tmp/project",
      provider: "google",
      model: "gemini-2.5-flash",
      enableMcp: false,
      config: {
        backupsEnabled: false,
        childModelRoutingMode: "cross-provider-allowlist",
        preferredChildModelRef: "openai:gpt-5.4-mini",
        allowedChildModelRefs: ["openai:gpt-5.4-mini"],
        featureFlags: {
          workspace: {
            a2ui: false,
          },
        },
        providerOptions: {
          google: {
            nativeWebSearch: true,
          },
        },
      },
    });
    const state = jsonRpcControlResultSchemas["cowork/session/state/read"].parse({
      events: [
        {
          type: "config_updated",
          sessionId: "session-1",
          config: {
            provider: "google",
            model: "gemini-2.5-flash",
            workingDirectory: "/tmp/project",
          },
        },
        {
          type: "session_settings",
          sessionId: "session-1",
          enableMcp: false,
          enableMemory: true,
          memoryRequireApproval: false,
        },
        {
          type: "session_config",
          sessionId: "session-1",
          config: {
            backupsEnabled: false,
            preferredChildModelRef: "openai:gpt-5.4-mini",
            featureFlags: {
              workspace: {
                a2ui: false,
              },
            },
          },
        },
      ],
    });

    expect(request.config?.providerOptions?.google?.nativeWebSearch).toBe(true);
    expect(request.config?.featureFlags?.workspace?.a2ui).toBe(false);
    expect(state.events[2]?.type).toBe("session_config");
  });

  test("parses inspectAgent request and result envelopes", () => {
    const request = jsonRpcAgentRequestSchemas["cowork/session/agent/inspect"].parse({
      threadId: "thread-1",
      agentId: "agent-1",
    });
    const result = jsonRpcAgentResultSchemas["cowork/session/agent/inspect"].parse({
      event: {
        agent: {
          agentId: "agent-1",
          parentSessionId: "thread-1",
          role: "worker",
          mode: "collaborative",
          depth: 1,
          effectiveModel: "gpt-5.4",
          title: "child",
          provider: "openai",
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
          lifecycleState: "active",
          executionState: "completed",
          busy: false,
          lastMessagePreview: "done",
        },
        latestAssistantText: "done",
        parsedReport: {
          status: "completed",
          summary: "Task done",
        },
        reportRequired: true,
        reportFound: true,
        reportValid: true,
        reportBlockCount: 1,
        reportDiagnostic: null,
        sessionUsage: null,
        lastTurnUsage: null,
      },
    });

    expect(request.agentId).toBe("agent-1");
    expect(result.event.parsedReport?.summary).toBe("Task done");
  });

  test("parses spawnAgent request metadata", () => {
    const request = jsonRpcAgentRequestSchemas["cowork/session/agent/spawn"].parse({
      threadId: "thread-1",
      message: "Plan the auth refactor",
      nickname: " plan-auth ",
      profileRef: "workspace:qa-reviewer",
      taskType: "plan",
      targetPaths: ["src/auth", " test/auth ", "src/auth"],
    });

    expect(request.nickname).toBe("plan-auth");
    expect(request.profileRef).toBe("workspace:qa-reviewer");
    expect(request.taskType).toBe("plan");
    expect(request.targetPaths).toEqual(["src/auth", "test/auth", "src/auth"]);
  });

  test("parses agent profile CRUD control schemas", () => {
    const upsert = jsonRpcControlRequestSchemas["cowork/agentProfiles/upsert"].parse({
      cwd: "/tmp/project",
      profile: {
        version: 1,
        scope: "workspace",
        id: "qa-reviewer",
        displayName: "QA Reviewer",
        description: "Checks completed work.",
        enabled: true,
        baseRole: "reviewer",
        prompt: "Report concrete defects only.",
        allowedBuiltInTools: ["read", "grep"],
        allowedMcpServers: ["github"],
        skillNames: ["code-review"],
        model: "gpt-5-mini",
        reasoningEffort: "high",
        defaultTaskType: "verify",
        defaultContextMode: "brief",
      },
    });
    const copy = jsonRpcControlRequestSchemas["cowork/agentProfiles/copy"].parse({
      copy: {
        sourceRef: "workspace:qa-reviewer",
        targetScope: "global",
        targetId: "qa-reviewer-global",
        targetDisplayName: "QA Reviewer Global",
      },
    });
    const { scope, ...catalogProfile } = upsert.profile;
    const result = jsonRpcControlResultSchemas["cowork/agentProfiles/upsert"].parse({
      event: {
        type: "agent_profiles_catalog",
        sessionId: "thread-1",
        catalog: {
          profiles: [
            {
              scope: "workspace",
              path: "/tmp/project/.cowork/agent-profiles/qa-reviewer.json",
              effective: true,
              shadowed: false,
              profile: catalogProfile,
            },
          ],
          effectiveProfiles: [
            {
              scope: "workspace",
              path: "/tmp/project/.cowork/agent-profiles/qa-reviewer.json",
              effective: true,
              shadowed: false,
              profile: catalogProfile,
            },
          ],
          diagnostics: [],
          roots: {
            globalDir: "/tmp/home/.cowork/agent-profiles",
            workspaceDir: "/tmp/project/.cowork/agent-profiles",
          },
        },
      },
    });

    expect(scope).toBe("workspace");
    expect(copy.copy.targetId).toBe("qa-reviewer-global");
    expect(result.event.catalog.effectiveProfiles[0]?.profile.id).toBe("qa-reviewer");
  });

  test("parses waitForAgent any/all request modes and wait-result notifications", () => {
    const waitRequest = jsonRpcAgentRequestSchemas["cowork/session/agent/wait"].parse({
      threadId: "thread-1",
      agentIds: ["agent-1", "agent-2"],
      timeoutMs: 250,
      mode: "all",
      includeFinalMessage: true,
      includeReport: true,
    });
    const waitNotification = jsonRpcAgentNotificationSchemas[
      "cowork/session/agentWaitResult"
    ].parse({
      type: "agent_wait_result",
      sessionId: "thread-1",
      agentIds: ["agent-1", "agent-2"],
      timedOut: true,
      mode: "all",
      agents: [
        {
          agentId: "agent-1",
          parentSessionId: "thread-1",
          role: "worker",
          mode: "collaborative",
          depth: 1,
          nickname: "verify-auth",
          taskType: "verify",
          targetPaths: ["src/auth", "test/auth"],
          effectiveModel: "gpt-5.4",
          title: "child",
          provider: "openai",
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
          lifecycleState: "active",
          executionState: "completed",
          busy: false,
        },
        {
          agentId: "agent-2",
          parentSessionId: "thread-1",
          role: "worker",
          mode: "collaborative",
          depth: 1,
          nickname: "plan-auth",
          taskType: "plan",
          targetPaths: ["src/auth"],
          effectiveModel: "gpt-5.4",
          title: "child 2",
          provider: "openai",
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
          lifecycleState: "active",
          executionState: "running",
          busy: true,
        },
      ],
      readyAgentIds: ["agent-1"],
      inspections: [
        {
          agentId: "agent-1",
          latestAssistantText:
            'done\n\n<agent_report>{"status":"completed","summary":"Task done"}</agent_report>',
          parsedReport: {
            status: "completed",
            summary: "Task done",
          },
          reportRequired: true,
          reportFound: true,
          reportValid: true,
          reportBlockCount: 1,
          reportDiagnostic: null,
        },
      ],
    });

    expect(waitRequest.mode).toBe("all");
    expect(waitRequest.includeFinalMessage).toBe(true);
    expect(waitRequest.includeReport).toBe(true);
    expect(waitNotification.mode).toBe("all");
    expect(waitNotification.readyAgentIds).toEqual(["agent-1"]);
    expect(waitNotification.agents).toHaveLength(2);
    expect(waitNotification.inspections?.[0]?.parsedReport?.summary).toBe("Task done");
  });
});
