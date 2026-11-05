import { describe, expect, test } from "bun:test";
import {
  jsonRpcControlRequestSchemas,
  jsonRpcControlResultSchemas,
} from "../../../src/shared/jsonrpcControlSchemas";
import {
  jsonRpcRequests,
  jsonRpcResponseOverrides,
  latestRequest,
  registerWorkspaceSettingsSyncLifecycleHooks,
  setControlSessionConfigResponse,
  useAppStore,
  workspaceId,
} from "./workspace-settings-sync.harness";

describe("tool calling settings & endpoint capability check", () => {
  registerWorkspaceSettingsSyncLifecycleHooks();

  test("validates cowork/provider/capabilities/check request and result schemas", () => {
    const req = jsonRpcControlRequestSchemas["cowork/provider/capabilities/check"].parse({
      cwd: "/tmp/workspace",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      strategy: "auto",
      refresh: true,
    });
    expect(req.provider).toBe("anthropic");

    const res = jsonRpcControlResultSchemas["cowork/provider/capabilities/check"].parse({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      strategy: "auto",
      capabilities: {
        provider: "anthropic",
        modelId: "claude-sonnet-4-6",
        endpointHost: "api.anthropic.com",
        nativeToolSearch: "anthropicBm25",
        nativeProgrammaticToolCalling: "anthropicCodeExecution20260120",
        source: "endpointCheck",
        checkedAtMs: 1_762_000_000_000,
        detail: "Verified via GET /v1/models/claude-sonnet-4-6 (HTTP 200)",
      },
    });
    expect(res.capabilities.nativeToolSearch).toBe("anthropicBm25");
    expect(res.capabilities.nativeProgrammaticToolCalling).toBe("anthropicCodeExecution20260120");
  });

  test("updateWorkspaceDefaults syncs defaultToolCalling and clearDefaultToolCalling over JsonRpcSocket", async () => {
    jsonRpcRequests.length = 0;
    setControlSessionConfigResponse({
      yolo: false,
      observabilityEnabled: false,
      backupsEnabled: false,
      defaultBackupsEnabled: false,
      enableMemory: true,
      memoryRequireApproval: false,
      preferredChildModel: "gpt-5.4",
      childModelRoutingMode: "same-provider",
      preferredChildModelRef: "openai:gpt-5.4",
      allowedChildModelRefs: [],
      maxSteps: 100,
      toolOutputOverflowChars: 25000,
      toolCalling: {
        codeMode: true,
        deferredToolSearch: true,
        strategy: "native",
      },
      userName: "Taylor",
      userProfile: {
        instructions: "",
        work: "",
        details: "",
      },
    });

    await useAppStore.getState().updateWorkspaceDefaults(workspaceId, {
      defaultToolCalling: {
        codeMode: true,
        deferredToolSearch: true,
        strategy: "native",
      },
    });

    const updatedWorkspace = useAppStore
      .getState()
      .workspaces.find((entry) => entry.id === workspaceId);
    expect(updatedWorkspace?.defaultToolCalling).toEqual({
      codeMode: true,
      deferredToolSearch: true,
      strategy: "native",
    });
    expect(latestRequest("cowork/session/defaults/apply")?.params).toMatchObject({
      cwd: "/tmp/workspace",
      config: {
        toolCalling: {
          codeMode: true,
          deferredToolSearch: true,
          strategy: "native",
        },
      },
    });

    setControlSessionConfigResponse({
      yolo: false,
      observabilityEnabled: false,
      backupsEnabled: false,
      defaultBackupsEnabled: false,
      enableMemory: true,
      memoryRequireApproval: false,
      preferredChildModel: "gpt-5.4",
      childModelRoutingMode: "same-provider",
      preferredChildModelRef: "openai:gpt-5.4",
      allowedChildModelRefs: [],
      maxSteps: 100,
      toolOutputOverflowChars: 25000,
      toolCalling: {
        codeMode: false,
        deferredToolSearch: false,
        strategy: "auto",
      },
      userName: "Taylor",
      userProfile: {
        instructions: "",
        work: "",
        details: "",
      },
    });

    await useAppStore.getState().updateWorkspaceDefaults(workspaceId, {
      clearDefaultToolCalling: true,
    });

    const clearedWorkspace = useAppStore
      .getState()
      .workspaces.find((entry) => entry.id === workspaceId);
    expect(clearedWorkspace?.defaultToolCalling).toBeUndefined();
    expect(latestRequest("cowork/session/defaults/apply")?.params).toMatchObject({
      cwd: "/tmp/workspace",
      config: {
        clearToolCalling: true,
      },
    });
  });

  test("checkProviderCapabilities invokes cowork/provider/capabilities/check and returns parsed result", async () => {
    jsonRpcRequests.length = 0;
    jsonRpcResponseOverrides.set("cowork/provider/capabilities/check", () => ({
      provider: "openai",
      model: "gpt-5.4",
      strategy: "auto",
      capabilities: {
        provider: "openai",
        modelId: "gpt-5.4",
        endpointHost: "api.openai.com",
        nativeToolSearch: "openAiResponses",
        nativeProgrammaticToolCalling: "openAiResponses",
        source: "endpointCheck",
        detail: "Verified via GET /models/gpt-5.4 (HTTP 200)",
      },
    }));

    try {
      const result = await useAppStore.getState().checkProviderCapabilities({
        workspaceId,
        provider: "openai",
        model: "gpt-5.4",
        strategy: "auto",
        refresh: true,
      });

      expect(result).not.toBeNull();
      expect(result?.capabilities.nativeToolSearch).toBe("openAiResponses");
      expect(result?.capabilities.nativeProgrammaticToolCalling).toBe("openAiResponses");
      expect(latestRequest("cowork/provider/capabilities/check")?.params).toEqual({
        cwd: "/tmp/workspace",
        provider: "openai",
        model: "gpt-5.4",
        strategy: "auto",
        refresh: true,
      });
    } finally {
      jsonRpcResponseOverrides.delete("cowork/provider/capabilities/check");
    }
  });
});
