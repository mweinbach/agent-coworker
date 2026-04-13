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
  input: "raw" | "stripped";
  matches: (command: string) => boolean;
};

const SHELL_COMMAND_ARG_FLAGS = new Set(["-c", "-command", "--command"]);
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
const WRAPPER_OPTIONS_WITH_VALUES: Record<string, Set<string>> = {
  exec: new Set(["-a"]),
  nice: new Set(["-n", "--adjustment"]),
  sudo: new Set([
    "-C",
    "-D",
    "-g",
    "-h",
    "-p",
    "-R",
    "-r",
    "-t",
    "-T",
    "-u",
    "--chdir",
    "--close-from",
    "--group",
    "--host",
    "--other-user",
    "--prompt",
    "--role",
    "--type",
    "--user",
  ]),
  time: new Set(["-f", "-o"]),
};
const ENV_OPTIONS_WITH_VALUES = new Set([
  "-c",
  "-p",
  "-s",
  "-u",
  "--argv0",
  "--block-signal",
  "--chdir",
  "--default-signal",
  "--ignore-signal",
  "--split-string",
  "--unset",
]);

function regexRule(reason: ShellCommandPolicyViolation["reason"], pattern: RegExp): ShellCommandRule {
  return {
    reason,
    input: "stripped",
    matches: (command) => pattern.test(command),
  };
}

const SHELL_WRITE_RULES: ShellCommandRule[] = [
  {
    reason: "filesystem mutation command",
    input: "raw",
    matches: (command) => hasFilesystemMutationCommand(command),
  },
  regexRule("shell redirection or tee write", /(?<!<)\d*>>?\s*(?!&\d+\b|\/dev\/null\b)\S+/),
  {
    reason: "shell redirection or tee write",
    input: "raw",
    matches: (command) => hasTeeWriteCommand(command),
  },
  regexRule(
    "in-place editor",
    /\bsed\b[^\n\r]*\s-i(?:\b|["'])|\bperl\b[^\n\r]*(?:\s-pi\b|\s-p\b[^\n\r]*\s-i\b)/,
  ),
  {
    reason: "git write command",
    input: "raw",
    matches: (command) => hasGitWriteCommand(command),
  },
  {
    reason: "package install command",
    input: "raw",
    matches: (command) => hasPackageInstallCommand(command),
  },
];

function consumeQuotedShellToken(
  command: string,
  startIndex: number,
  quote: "'" | '"' | "`",
): { value: string; endIndex: number } {
  let value = "";
  let index = startIndex;

  while (index < command.length) {
    const ch = command[index];
    if (!ch) break;

    if (quote !== "'" && ch === "\\") {
      const next = command[index + 1];
      if (next) {
        value += next;
        index += 2;
        continue;
      }
    }

    if (ch === quote) {
      return { value, endIndex: index + 1 };
    }

    value += ch;
    index += 1;
  }

  return { value, endIndex: index };
}

function tokenizeShellCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let index = 0;

  const pushCurrent = () => {
    if (!current) return;
    tokens.push(current);
    current = "";
  };

  while (index < command.length) {
    const ch = command[index];
    const next = command[index + 1];
    if (!ch) break;

    if (/\s/.test(ch)) {
      pushCurrent();
      index += 1;
      continue;
    }

    if (ch === "&" && next === "&") {
      pushCurrent();
      tokens.push("&&");
      index += 2;
      continue;
    }

    if (ch === "|" && next === "|") {
      pushCurrent();
      tokens.push("||");
      index += 2;
      continue;
    }

    if (SHELL_COMMAND_SEPARATORS.has(ch)) {
      pushCurrent();
      tokens.push(ch);
      index += 1;
      continue;
    }

    if (ch === "\\" && next) {
      current += next;
      index += 2;
      continue;
    }

    if (ch === "$" && (next === "'" || next === '"')) {
      const quoted = consumeQuotedShellToken(command, index + 2, next);
      current += quoted.value;
      index = quoted.endIndex;
      continue;
    }

    if (ch === "'" || ch === '"' || ch === "`") {
      const quoted = consumeQuotedShellToken(command, index + 1, ch);
      current += quoted.value;
      index = quoted.endIndex;
      continue;
    }

    current += ch;
    index += 1;
  }

  pushCurrent();
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
    if (baseName === "env") {
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
        const option = (envToken.split("=")[0] ?? envToken).toLowerCase();
        if (ENV_OPTIONS_WITH_VALUES.has(option)) {
          index += envToken.includes("=") ? 1 : 2;
          continue;
        }
        if (/^-[A-Za-z-]+$/.test(envToken)) {
          index += 1;
          continue;
        }
        break;
      }
      continue;
    }

    while (index < tokens.length) {
      const wrapperToken = tokens[index];
      if (!wrapperToken) break;
      if (wrapperToken === "--") {
        index += 1;
        break;
      }
      if (isEnvAssignmentToken(wrapperToken)) {
        index += 1;
        continue;
      }

      if (!wrapperToken.startsWith("-") || wrapperToken === "-") {
        break;
      }

      const option = wrapperToken.split("=")[0] ?? wrapperToken;
      if (baseName === "command") {
        if (option === "-v" || option === "-V") {
          return -1;
        }
        if (option !== "-p") {
          break;
        }
        index += 1;
        continue;
      }

      const optionsWithValues = WRAPPER_OPTIONS_WITH_VALUES[baseName];
      if (optionsWithValues?.has(option) && !wrapperToken.includes("=")) {
        index += 2;
        continue;
      }

      index += 1;
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

function hasTeeWriteCommand(command: string): boolean {
  for (const segment of splitShellCommandIntoSegments(command)) {
    const executableIndex = findSegmentExecutableIndex(segment);
    if (executableIndex < 0) continue;
    if (getShellTokenBaseName(segment[executableIndex] ?? "") !== "tee") continue;

    for (let index = executableIndex + 1; index < segment.length; index += 1) {
      const token = segment[index];
      if (!token) continue;
      if (token === "--") {
        return index + 1 < segment.length;
      }
      if (!token.startsWith("-") || token === "-") {
        return true;
      }
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

      if (normalizedArg.startsWith("--command=") || normalizedArg.startsWith("-command=")) {
        const inlineSegment = arg.slice(arg.indexOf("=") + 1).trim();
        if (inlineSegment) segments.push(unwrapShellTokenValue(inlineSegment));
        break;
      }

      if (SHELL_COMMAND_ARG_FLAGS.has(normalizedArg) || /^-[a-z]*c$/i.test(normalizedArg)) {
        const segment = commandSegment[j + 1]?.trim();
        if (segment) segments.push(segment);
        break;
      }

      const shortInlineMatch = arg.match(/^-c(?!ommand\b)(.+)$/i);
      if (shortInlineMatch) {
        const inlineSegment = shortInlineMatch[1]?.trim();
        if (inlineSegment) segments.push(unwrapShellTokenValue(inlineSegment));
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
  const candidates = new Map<string, string>();
  const addCandidate = (candidate: string) => {
    const key = normalizeShellCommandForPolicy(candidate);
    if (!key || candidates.has(key)) return;
    candidates.set(key, candidate);
  };

  addCandidate(command);

  if (depth >= 2) {
    return [...candidates.values()];
  }

  const executedSegments = [
    ...extractCommandSubstitutionSegments(command),
    ...extractShellCommandStringSegments(command),
  ];
  for (const segment of executedSegments) {
    for (const candidate of collectShellPolicyCandidates(segment, depth + 1)) {
      addCandidate(candidate);
    }
  }

  return [...candidates.values()];
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
      const policyInput = normalizeShellCommandForPolicy(
        rule.input === "raw" ? candidate : buildTopLevelPolicyCandidate(candidate),
      );
      if (!policyInput) continue;
      if (rule.matches(policyInput)) {
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
