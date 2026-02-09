import { claudeCode, createClaudeCode, type ClaudeCodeSettings } from "ai-sdk-provider-claude-code";

import type { AgentConfig } from "../types";

export const DEFAULT_CLAUDE_CODE_PROVIDER_OPTIONS = {
  // NOTE: Claude Code is configured primarily via model settings:
  //   claudeCode(modelId, settings)
  // This object is a reference template (and is empty by default).

  // pathToClaudeCodeExecutable: "claude",
  // customSystemPrompt: undefined,
  // appendSystemPrompt: undefined,
  // systemPrompt: { type: "preset", preset: "claude_code", append: "..." },

  // maxTurns: 10,
  // maxThinkingTokens: 0,
  // cwd: "/path/to/project",
  // executable: "node", // "node" | "bun" | "deno"
  // executableArgs: [],

  // permissionMode: "default",
  // permissionPromptToolName: undefined,
  // continue: false,
  // resume: undefined,
  // sessionId: undefined,
  // allowedTools: ["Read", "LS"],
  // disallowedTools: ["Write", "Edit"],

  // betas: [],
  // allowDangerouslySkipPermissions: false,
  // enableFileCheckpointing: false,
  // maxBudgetUsd: undefined,
  // plugins: [],
  // resumeSessionAt: undefined,
  // sandbox: undefined,
  // tools: undefined,
  // mcpServers: undefined,
  // settingSources: ["user", "project"],
  // hooks: undefined,
  // canUseTool: undefined,
  // streamingInput: "auto", // "auto" | "always" | "off"

  // verbose: false,
  // debug: false,
  // debugFile: undefined,
  // logger: undefined, // Logger | false
  // env: undefined,
  // additionalDirectories: [],

  // agents: undefined,
  // includePartialMessages: false,
  // fallbackModel: undefined,
  // forkSession: false,
  // stderr: undefined,
  // strictMcpConfig: false,
  // extraArgs: undefined,
  // persistSession: true,
  // spawnClaudeCodeProcess: undefined,
  // sdkOptions: undefined,
  // maxToolResultSize: 10000,
  // onQueryCreated: undefined,
  // onStreamStart: undefined,
} as const satisfies Partial<ClaudeCodeSettings>;

export const claudeCodeProvider = {
  defaultModel: "sonnet",
  keyCandidates: ["claude-code", "anthropic"] as const,
  createModel: ({ modelId, savedKey }: { config: AgentConfig; modelId: string; savedKey?: string }) => {
    const envKey = savedKey || process.env.ANTHROPIC_API_KEY;
    const provider = envKey
      ? createClaudeCode({
          defaultSettings: {
            env: {
              ANTHROPIC_API_KEY: envKey,
            },
          },
        })
      : claudeCode;
    return provider(modelId);
  },
};
