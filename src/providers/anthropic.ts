import { createAnthropicModelAdapter } from "./modelAdapter";
import type { AgentConfig } from "../types";

function normalizeAnthropicModelId(modelId: string): string {
  const normalized = modelId.trim().toLowerCase();
  if (normalized === "claude-sonnet-4-6") {
    return "claude-sonnet-4-6";
  }
  return modelId;
}

export const DEFAULT_ANTHROPIC_PROVIDER_OPTIONS = {
  thinking: {
    type: "enabled",
    budgetTokens: 32_000,
  },
  disableParallelToolUse: true,

  // Other Anthropic provider options you can enable/override:
  // sendReasoning: true,
  // structuredOutputMode: "auto", // "outputFormat" | "jsonTool" | "auto"
  // disableParallelToolUse: false,
  // cacheControl: { type: "ephemeral", ttl: "1h" },
  // mcpServers: [
  //   {
  //     type: "url",
  //     name: "docs",
  //     url: "https://mcp.example.com",
  //     authorizationToken: null,
  //     toolConfiguration: { enabled: null, allowedTools: null },
  //   },
  // ],
  // container: {
  //   id: undefined,
  //   skills: [{ type: "anthropic", skillId: "pdf", version: "1" }],
  // },
  // toolStreaming: true,
  // effort: "high", // "low" | "medium" | "high" | "max"
  // contextManagement: {
  //   edits: [
  //     { type: "clear_thinking_20251015", keep: "all" },
  //     // { type: "clear_tool_uses_20250919", trigger: { type: "input_tokens", value: 12000 } },
  //   ],
  // },
} as const;

export const anthropicProvider = {
  keyCandidates: ["anthropic"] as const,
  createModel: ({ modelId, savedKey }: { config: AgentConfig; modelId: string; savedKey?: string }) =>
    createAnthropicModelAdapter(normalizeAnthropicModelId(modelId), savedKey),
};
