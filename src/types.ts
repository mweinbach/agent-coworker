import type { ModelMessage } from "ai";

export type ProviderName = "google" | "openai" | "anthropic";

export interface AgentConfig {
  provider: ProviderName;
  model: string;
  subAgentModel: string;

  workingDirectory: string;
  outputDirectory: string;
  uploadsDirectory: string;

  userName: string;
  knowledgeCutoff: string;

  projectAgentDir: string;
  userAgentDir: string;
  builtInDir: string;
  builtInConfigDir: string;

  skillsDirs: string[];
  memoryDirs: string[];
  configDirs: string[];

  /**
   * Optional AI SDK providerOptions to pass through to model calls.
   * This lets us tune reasoning/thinking behavior per provider without hardcoding it in every call site.
   */
  providerOptions?: Record<string, any>;
}

export interface SkillEntry {
  name: string;
  path: string;
  source: "project" | "user" | "built-in";
  triggers: string[];
  description: string;
}

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm: string;
}

export type AgentMessages = ModelMessage[];

export type MCPServerTransport =
  | { type: "stdio"; command: string; args: string[] }
  | { type: "http"; url: string };

export interface MCPServerConfig {
  name: string;
  transport: MCPServerTransport;
  required?: boolean;
  retries?: number;
}
