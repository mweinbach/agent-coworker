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

const SHELL_COMMAND_ARG_FLAGS = new Set(["-c", "--command"]);
const SHELL_COMMAND_LAUNCHERS = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "fish",
  "pwsh",
  "powershell",
  "powershell.exe",
]);

const SHELL_WRITE_RULES: ShellCommandRule[] = [
  {
    reason: "filesystem mutation command",
    pattern: /(?:^|[\s;&|()]+)(?:rm|mv|cp|touch|mkdir)\b/,
  },
  {
    reason: "shell redirection or tee write",
    pattern: /(?<!<)\d*>>?\s*(?!&\d+\b|\/dev\/null\b)\S+|\btee\b/,
  },
  {
    reason: "in-place editor",
    pattern: /\bsed\b[^\n\r]*\s-i(?:\b|["'])|\bperl\b[^\n\r]*(?:\s-pi\b|\s-p\b[^\n\r]*\s-i\b)/,
  },
  {
    reason: "git write command",
    pattern:
      /(?:^|[\s;&|()]+)git\s+(?:add|commit|checkout|switch|restore|clean)\b|(?:^|[\s;&|()]+)git\s+reset\b[^\n\r]*(?:^|[\s])--hard(?:$|[\s])/,
  },
  {
    reason: "package install command",
    pattern:
      /(?:^|[\s;&|()]+)(?:npm\s+(?:install|i|ci)\b|pnpm\s+(?:install|i|add)\b|yarn(?:\s+(?:install|add)\b|$)|bun\s+(?:install|i|add)\b|(?:pip|pip3)\s+install\b|(?:python|python3|py)\s+-m\s+pip\s+install\b|uv\s+pip\s+install\b|cargo\s+add\b)/,
  },
];

function tokenizeShellCommand(command: string): string[] {
  const tokens: string[] = [];
  const re =
    /((?:--[a-zA-Z0-9-]+|-[a-zA-Z0-9])=(?:"[^"]*"|'[^']*'|`[^`]*`|\$"[^"]*"|\$'[^']*'|\S+)|"([^"]*)"|'([^']*)'|`([^`]*)`|\$"([^"]*)"|\$'([^']*)'|(\S+))/g;

  let match: RegExpExecArray | null = null;
  while ((match = re.exec(command)) !== null) {
    const token = match[2] ?? match[3] ?? match[4] ?? match[5] ?? match[6] ?? match[7] ?? match[1] ?? "";
    if (token) tokens.push(token);
  }

  return tokens;
}

function unwrapShellTokenValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("$'") && trimmed.endsWith("'")) {
    return trimmed.slice(2, -1);
  }
  if (trimmed.startsWith('$"') && trimmed.endsWith('"')) {
    return trimmed.slice(2, -1);
  }
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("`") && trimmed.endsWith("`"))
  ) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

function stripSingleAndDoubleQuotedSegments(command: string): string {
  return command.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, " ");
}

function extractCommandSubstitutionSegments(command: string): string[] {
  const segments: string[] = [];
  const re = /\$\(((?:\\.|[^()\\])*)\)|`((?:\\.|[^`\\])*)`/g;
  let match: RegExpExecArray | null = null;

  while ((match = re.exec(command)) !== null) {
    const segment = (match[1] ?? match[2] ?? "").trim();
    if (segment) segments.push(segment);
  }

  return segments;
}

function stripCommandSubstitutionSegments(command: string): string {
  return command.replace(/\$\((?:\\.|[^()\\])*\)|`(?:\\.|[^`\\])*`/g, " ");
}

function extractShellCommandStringSegments(command: string): string[] {
  const tokens = tokenizeShellCommand(command);
  const segments: string[] = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]?.toLowerCase();
    if (!token || !SHELL_COMMAND_LAUNCHERS.has(token)) continue;

    for (let j = i + 1; j < tokens.length; j += 1) {
      const arg = tokens[j];
      const normalizedArg = arg?.toLowerCase();
      if (!normalizedArg) break;

      if (normalizedArg.startsWith("--command=")) {
        const inlineSegment = arg.slice(arg.indexOf("=") + 1).trim();
        if (inlineSegment) segments.push(unwrapShellTokenValue(inlineSegment));
        break;
      }

      const shortInlineMatch = arg.match(/^-c(.+)$/i);
      if (shortInlineMatch) {
        const inlineSegment = shortInlineMatch[1]?.trim();
        if (inlineSegment) segments.push(unwrapShellTokenValue(inlineSegment));
        break;
      }

      if (SHELL_COMMAND_ARG_FLAGS.has(normalizedArg) || /^-[a-z]*c$/i.test(normalizedArg)) {
        const segment = tokens[j + 1]?.trim();
        if (segment) segments.push(segment);
        break;
      }
      if (!normalizedArg.startsWith("-")) {
        break;
      }
    }
  }

  return segments;
}

function normalizeShellCommandForPolicy(command: string): string {
  return command.toLowerCase().replace(/\s+/g, " ").trim();
}

function buildTopLevelPolicyCandidate(command: string): string {
  return stripCommandSubstitutionSegments(stripSingleAndDoubleQuotedSegments(command));
}

function collectShellPolicyCandidates(command: string, depth = 0): string[] {
  const candidates: string[] = [];
  const topLevelCandidate = normalizeShellCommandForPolicy(buildTopLevelPolicyCandidate(command));
  if (topLevelCandidate) {
    candidates.push(topLevelCandidate);
  }

  if (depth >= 2) {
    return [...new Set(candidates)];
  }

  const executedSegments = [
    ...extractCommandSubstitutionSegments(command),
    ...extractShellCommandStringSegments(command),
  ];
  for (const segment of executedSegments) {
    candidates.push(...collectShellPolicyCandidates(segment, depth + 1));
  }

  return [...new Set(candidates.filter(Boolean))];
}

export function getShellCommandPolicyViolation(
  command: string,
  shellPolicy: AgentShellPolicy | null | undefined,
): ShellCommandPolicyViolation | null {
  if ((shellPolicy ?? "full") !== "no_project_write") {
    return null;
  }

  const candidates = collectShellPolicyCandidates(command);
  for (const rule of SHELL_WRITE_RULES) {
    for (const candidate of candidates) {
      if (rule.pattern.test(candidate)) {
        return { shellPolicy: "no_project_write", reason: rule.reason };
      }
    }
  }

  return null;
}

export const __internal = {
  collectShellPolicyCandidates,
  normalizeShellCommandForPolicy,
};
