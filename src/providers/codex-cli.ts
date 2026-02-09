import { codexCli, createCodexCli, type CodexCliProviderOptions } from "ai-sdk-provider-codex-cli";

import type { AgentConfig } from "../types";

export const DEFAULT_CODEX_CLI_PROVIDER_OPTIONS = {
  // Per-call overrides via AI SDK `providerOptions["codex-cli"]`.
  reasoningEffort: "high",
  reasoningSummary: "detailed",
  // reasoningSummaryFormat: "markdown",
  textVerbosity: "high",
  // addDirs: ["/path/to/extra/context"],
  // configOverrides: {
  //   experimental_resume: "/tmp/session.jsonl",
  // },
  // mcpServers: {
  //   local: { transport: "stdio", command: "node", args: ["tools/mcp.js"] },
  // },
  // rmcpClient: true,
} as const satisfies CodexCliProviderOptions;

export const codexCliProvider = {
  defaultModel: "gpt-5.3-codex",
  keyCandidates: ["codex-cli", "openai"] as const,
  createModel: ({ modelId, savedKey }: { config: AgentConfig; modelId: string; savedKey?: string }) => {
    // Default to Codex CLI's local auth (~/.codex/auth.json) rather than OPENAI_API_KEY.
    // Only use an API key when the user explicitly saved one in ~/.cowork/auth/connections.json.
    const provider = savedKey
      ? createCodexCli({
          defaultSettings: {
            env: {
              OPENAI_API_KEY: savedKey,
            },
          },
        })
      : codexCli;
    return provider(modelId);
  },
};
