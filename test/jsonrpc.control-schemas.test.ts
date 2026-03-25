import { describe, expect, test } from "bun:test";

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
        providers: [{
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
            rateLimits: [{
              limitName: "requests",
              primaryWindow: {
                usedPercent: 12,
                windowSeconds: 60,
              },
            }],
          },
        }],
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
        servers: [{
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
        }],
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
        files: [{
          source: "workspace",
          path: "/tmp/project/.cowork/mcp-servers.json",
          exists: true,
          editable: true,
          legacy: false,
          serverCount: 1,
        }],
        warnings: ["oauth pending"],
      },
    });

    expect(parsed.event.servers[0]?.authMode).toBe("oauth_pending");
    expect(parsed.event.files[0]?.editable).toBe(true);
  });

  test("parses memory list envelopes", () => {
    const parsed = jsonRpcControlResultSchemas["cowork/memory/list"].parse({
      event: {
        type: "memory_list",
        sessionId: "session-1",
        memories: [{
          id: "hot",
          scope: "workspace",
          content: "Remember this",
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        }],
      },
    });

    expect(parsed.event.memories[0]?.id).toBe("hot");
  });

  test("parses workspace backup envelopes", () => {
    const parsed = jsonRpcControlResultSchemas["cowork/backups/workspace/read"].parse({
      event: {
        type: "workspace_backups",
        sessionId: "session-1",
        workspacePath: "/tmp/project",
        backups: [{
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
          checkpoints: [{
            id: "cp-1",
            index: 1,
            createdAt: new Date(0).toISOString(),
            trigger: "manual",
            changed: true,
            patchBytes: 20,
          }],
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        }],
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
          },
        },
      ],
    });

    expect(request.config?.providerOptions?.google?.nativeWebSearch).toBe(true);
    expect(state.events[2]?.type).toBe("session_config");
  });
});
