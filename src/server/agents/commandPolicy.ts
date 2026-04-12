export type AgentShellPolicy = "full" | "no_project_write";

type ShellCommandPolicyViolation = {
  shellPolicy: "no_project_write";
  reason:
    | "filesystem mutation command"
    | "shell redirection or tee write"
    | "in-place editor"
    | "git write command"
    | "package install command";
};

type ShellCommandRule = {
  reason: ShellCommandPolicyViolation["reason"];
  pattern: RegExp;
};

const SHELL_WRITE_RULES: ShellCommandRule[] = [
  {
    reason: "filesystem mutation command",
    pattern: /(?:^|[\s;&|()]+)(?:rm|mv|cp|touch|mkdir)\b/,
  },
  {
    reason: "shell redirection or tee write",
    pattern: /(?:\d*>>?\s*\S)|\btee\b/,
  },
  {
    reason: "in-place editor",
    pattern: /\bsed\b[^\n\r]*\s-i(?:\b|["'])|\bperl\b[^\n\r]*(?:\s-pi\b|\s-p\b[^\n\r]*\s-i\b)/,
  },
  {
    reason: "git write command",
    pattern:
      /(?:^|[\s;&|()]+)git\s+(?:add|commit|checkout|switch|restore|clean)\b|(?:^|[\s;&|()]+)git\s+reset\b[^\n\r]*\b--hard\b/,
  },
  {
    reason: "package install command",
    pattern:
      /(?:^|[\s;&|()]+)(?:npm\s+(?:install|i)\b|pnpm\s+(?:install|add)\b|bun\s+(?:install|add)\b|(?:pip|pip3)\s+install\b|(?:python|python3|py)\s+-m\s+pip\s+install\b|uv\s+pip\s+install\b|cargo\s+add\b)/,
  },
];

function stripQuotedShellSegments(command: string): string {
  return command.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g, " ");
}

function normalizeShellCommandForPolicy(command: string): string {
  return stripQuotedShellSegments(command).toLowerCase().replace(/\s+/g, " ").trim();
}

export function getShellCommandPolicyViolation(
  command: string,
  shellPolicy: AgentShellPolicy | null | undefined,
): ShellCommandPolicyViolation | null {
  if ((shellPolicy ?? "full") !== "no_project_write") {
    return null;
  }

  const normalized = normalizeShellCommandForPolicy(command);
  for (const rule of SHELL_WRITE_RULES) {
    if (rule.pattern.test(normalized)) {
      return { shellPolicy: "no_project_write", reason: rule.reason };
    }
  }

  return null;
}

export function isShellCommandAllowedByPolicy(
  command: string,
  shellPolicy: AgentShellPolicy | null | undefined,
): boolean {
  return getShellCommandPolicyViolation(command, shellPolicy) === null;
}

export const __internal = {
  normalizeShellCommandForPolicy,
};
