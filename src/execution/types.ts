import type { AgentConfig } from "../types";

export type ToolExecutionBackendKind = "local" | "sandbox";

export interface ShellExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  errorCode?: string;
}

export interface TextRangeLine {
  lineNumber: number;
  text: string;
}

export interface ReadTextRangeResult {
  lines: TextRangeLine[];
  totalLineCount: number;
}

export interface GlobMatch {
  path: string;
  mtimeMs: number;
}

export interface GlobResult {
  matches: GlobMatch[];
  truncated: boolean;
}

export interface ToolExecutionBackend {
  kind: ToolExecutionBackendKind;
  displayName: string;
  runShellCommand: (opts: {
    command: string;
    cwd: string;
    abortSignal?: AbortSignal;
  }) => Promise<ShellExecutionResult>;
  runRipgrep: (opts: {
    rgPath: string;
    args: string[];
    cwd: string;
    abortSignal?: AbortSignal;
  }) => Promise<ShellExecutionResult>;
  readTextFile: (opts: { filePath: string }) => Promise<string>;
  readTextRange: (opts: {
    filePath: string;
    offset?: number;
    limit: number;
    abortSignal?: AbortSignal;
  }) => Promise<ReadTextRangeResult>;
  readBinaryFile: (opts: { filePath: string }) => Promise<Uint8Array>;
  writeTextFile: (opts: { filePath: string; content: string }) => Promise<void>;
  makeDirectory: (opts: { dirPath: string }) => Promise<void>;
  glob: (opts: {
    pattern: string;
    cwd: string;
    maxResults: number;
    abortSignal?: AbortSignal;
  }) => Promise<GlobResult>;
}

export type ToolExecutionBackendFactory = (opts: {
  config: AgentConfig;
  log: (line: string) => void;
}) => ToolExecutionBackend;
