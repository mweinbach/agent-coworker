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
  matches: (command: string) => boolean;
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
const SHELL_COMMAND_SEPARATORS = new Set([";", "&&", "||", "|", "&", "(", ")"]);
const SHELL_EXECUTION_WRAPPERS = new Set([
  "builtin",
  "command",
  "env",
  "exec",
  "nice",
  "nohup",
  "sudo",
  "time",
]);
const FILESYSTEM_MUTATION_COMMANDS = new Set(["rm", "mv", "cp", "touch", "mkdir"]);
const GIT_WRITE_SUBCOMMANDS = new Set(["add", "commit", "checkout", "switch", "restore", "clean"]);
const GIT_GLOBAL_OPTIONS_WITH_VALUES = new Set([
  "-c",
  "-C",
  "--config-env",
  "--exec-path",
  "--git-dir",
  "--namespace",
  "--super-prefix",
  "--work-tree",
]);

function regexRule(reason: ShellCommandPolicyViolation["reason"], pattern: RegExp): ShellCommandRule {
  return {
    reason,
    matches: (command) => pattern.test(command),
  };
}

const SHELL_WRITE_RULES: ShellCommandRule[] = [
  {
    reason: "filesystem mutation command",
    matches: (command) => hasFilesystemMutationCommand(command),
  },
  regexRule("shell redirection or tee write", /(?<!<)\d*>>?\s*(?!&\d+\b|\/dev\/null\b)\S+|\btee\b/),
  regexRule(
    "in-place editor",
    /\bsed\b[^\n\r]*\s-i(?:\b|["'])|\bperl\b[^\n\r]*(?:\s-pi\b|\s-p\b[^\n\r]*\s-i\b)/,
  ),
  {
    reason: "git write command",
    matches: (command) => hasGitWriteCommand(command),
  },
  {
    reason: "package install command",
    matches: (command) => hasPackageInstallCommand(command),
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

function getShellTokenBaseName(token: string): string {
  const normalized = token.replace(/\\/g, "/").replace(/\/+$/, "");
  const lastPathComponent = normalized.split("/").pop() ?? normalized;
  return lastPathComponent.toLowerCase();
}

function isEnvAssignmentToken(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token);
}

function splitShellCommandIntoSegments(command: string): string[][] {
  const tokens = tokenizeShellCommand(command);
  const segments: string[][] = [];
  let currentSegment: string[] = [];

  for (const token of tokens) {
    if (SHELL_COMMAND_SEPARATORS.has(token)) {
      if (currentSegment.length > 0) {
        segments.push(currentSegment);
        currentSegment = [];
      }
      continue;
    }
    currentSegment.push(token);
  }

  if (currentSegment.length > 0) {
    segments.push(currentSegment);
  }

  return segments;
}

function findSegmentExecutableIndex(tokens: string[]): number {
  let index = 0;
  while (index < tokens.length && isEnvAssignmentToken(tokens[index] ?? "")) {
    index += 1;
  }

  while (index < tokens.length) {
    const token = tokens[index];
    if (!token) break;

    const baseName = getShellTokenBaseName(token);
    if (!SHELL_EXECUTION_WRAPPERS.has(baseName)) {
      return index;
    }

    index += 1;
    if (baseName !== "env") {
      continue;
    }

    while (index < tokens.length) {
      const envToken = tokens[index];
      if (!envToken) break;
      if (envToken === "--") {
        index += 1;
        break;
      }
      if (isEnvAssignmentToken(envToken)) {
        index += 1;
        continue;
      }
      if (/^-[A-Za-z-]+$/.test(envToken)) {
        index += 1;
        continue;
      }
      break;
    }
  }

  return -1;
}

function isShellCommandLauncherToken(token: string): boolean {
  return SHELL_COMMAND_LAUNCHERS.has(getShellTokenBaseName(token));
}

function hasFilesystemMutationCommand(command: string): boolean {
  for (const segment of splitShellCommandIntoSegments(command)) {
    const executableIndex = findSegmentExecutableIndex(segment);
    if (executableIndex < 0) continue;
    if (FILESYSTEM_MUTATION_COMMANDS.has(getShellTokenBaseName(segment[executableIndex] ?? ""))) {
      return true;
    }
  }

  return false;
}

function findGitSubcommandIndex(tokens: string[], gitIndex: number): number {
  let index = gitIndex + 1;
  while (index < tokens.length) {
    const token = tokens[index];
    if (!token) break;
    if (token === "--") {
      index += 1;
      break;
    }
    if (token.startsWith("--")) {
      const flag = token.split("=")[0] ?? token;
      if (GIT_GLOBAL_OPTIONS_WITH_VALUES.has(flag) && !token.includes("=")) {
        index += 2;
      } else {
        index += 1;
      }
      continue;
    }
    if (token.startsWith("-") && token !== "-") {
      if (GIT_GLOBAL_OPTIONS_WITH_VALUES.has(token)) {
        index += 2;
      } else {
        index += 1;
      }
      continue;
    }
    break;
  }

  return index;
}

function hasGitWriteCommand(command: string): boolean {
  for (const segment of splitShellCommandIntoSegments(command)) {
    const executableIndex = findSegmentExecutableIndex(segment);
    if (executableIndex < 0) continue;
    if (getShellTokenBaseName(segment[executableIndex] ?? "") !== "git") continue;

    const subcommandIndex = findGitSubcommandIndex(segment, executableIndex);
    const subcommand = segment[subcommandIndex]?.toLowerCase();
    if (!subcommand) continue;
    if (GIT_WRITE_SUBCOMMANDS.has(subcommand)) {
      return true;
    }
    if (subcommand === "reset") {
      const args = segment.slice(subcommandIndex + 1).map((arg) => arg.toLowerCase());
      if (args.includes("--hard")) {
        return true;
      }
    }
  }

  return false;
}

function hasPackageInstallCommand(command: string): boolean {
  for (const segment of splitShellCommandIntoSegments(command)) {
    const executableIndex = findSegmentExecutableIndex(segment);
    if (executableIndex < 0) continue;

    const executable = getShellTokenBaseName(segment[executableIndex] ?? "");
    const firstArg = segment[executableIndex + 1]?.toLowerCase();
    const secondArg = segment[executableIndex + 2]?.toLowerCase();
    const thirdArg = segment[executableIndex + 3]?.toLowerCase();

    if (executable === "npm" && ["install", "i", "ci"].includes(firstArg ?? "")) {
      return true;
    }
    if (executable === "pnpm" && ["install", "i", "add"].includes(firstArg ?? "")) {
      return true;
    }
    if (executable === "yarn" && (!firstArg || ["install", "add"].includes(firstArg))) {
      return true;
    }
    if (executable === "bun" && ["install", "i", "add"].includes(firstArg ?? "")) {
      return true;
    }
    if ((executable === "pip" || executable === "pip3") && firstArg === "install") {
      return true;
    }
    if (["python", "python3", "py"].includes(executable) && firstArg === "-m" && secondArg === "pip" && thirdArg === "install") {
      return true;
    }
    if (executable === "uv" && firstArg === "pip" && secondArg === "install") {
      return true;
    }
    if (executable === "cargo" && firstArg === "add") {
      return true;
    }
  }

  return false;
}

function stripSingleAndDoubleQuotedSegments(command: string): string {
  return command.replace(/"(?:\\.|[^"\\])*"|'[^']*'/g, " ");
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
  const segments: string[] = [];

  for (const commandSegment of splitShellCommandIntoSegments(command)) {
    const launcherIndex = findSegmentExecutableIndex(commandSegment);
    if (launcherIndex < 0) continue;
    if (!isShellCommandLauncherToken(commandSegment[launcherIndex] ?? "")) continue;

    for (let j = launcherIndex + 1; j < commandSegment.length; j += 1) {
      const arg = commandSegment[j];
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
        const segment = commandSegment[j + 1]?.trim();
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
      if (rule.matches(candidate)) {
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
