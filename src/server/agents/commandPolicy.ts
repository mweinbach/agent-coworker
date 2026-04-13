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
const SHELL_SHORT_NO_VALUE_COMMAND_FLAGS = new Set([
  "a",
  "c",
  "e",
  "i",
  "l",
  "r",
  "s",
  "v",
  "x",
]);
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
const SHELL_COMMAND_SEPARATORS = new Set([
  "!",
  "&",
  "&&",
  "(" ,
  ")" ,
  ";",
  "case",
  "do",
  "done",
  "elif",
  "else",
  "esac",
  "fi",
  "for",
  "{",
  "if",
  "in",
  "select",
  "then",
  "until",
  "while",
  "|",
  "||",
  "}",
]);
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
const FILESYSTEM_MUTATION_COMMANDS = new Set(["chmod", "cp", "ln", "mkdir", "mv", "rm", "touch", "truncate", "tar"]);
const INLINE_INTERPRETER_COMMANDS = new Set([
  "node",
  "nodejs",
  "perl",
  "python",
  "python3",
  "py",
  "ruby",
]);
const GIT_READ_ONLY_SUBCOMMANDS = new Set([
  "cat-file",
  "describe",
  "diff",
  "grep",
  "help",
  "log",
  "ls-files",
  "ls-tree",
  "rev-list",
  "rev-parse",
  "show",
  "show-ref",
  "status",
  "version",
]);
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
const SHELL_LAUNCHER_OPTIONS_WITH_VALUES: Record<string, Set<string>> = {
  bash: new Set(["--init-file", "--rcfile", "-o"]),
  dash: new Set(["-o"]),
  fish: new Set(["-C", "--init-command"]),
  ksh: new Set(["-o"]),
  powershell: new Set(["-configurationname", "-custompipename", "-ep", "-executionpolicy", "-file", "-inputformat", "-outputformat", "-settingsfile", "-version", "-workingdirectory"]),
  "powershell.exe": new Set(["-configurationname", "-custompipename", "-ep", "-executionpolicy", "-file", "-inputformat", "-outputformat", "-settingsfile", "-version", "-workingdirectory"]),
  pwsh: new Set(["-configurationname", "-custompipename", "-ep", "-executionpolicy", "-file", "-inputformat", "-outputformat", "-settingsfile", "-version", "-workingdirectory"]),
  sh: new Set(["-o"]),
  zsh: new Set(["-o"]),
};
const PACKAGE_MANAGER_OPTIONS_WITH_VALUES: Record<string, Set<string>> = {
  bun: new Set(["--cwd", "-c", "--config", "--filter"]),
  npm: new Set(["--cache", "--prefix", "--userconfig", "--workspace", "-w"]),
  pip: new Set(["--constraint", "--find-links", "--index-url", "--log", "--proxy", "--requirement", "--src", "--target", "-c", "-i", "-r", "-t"]),
  pnpm: new Set(["--dir", "-c", "--filter", "--workspace-dir"]),
  yarn: new Set(["--cache-folder", "--cwd", "--mutex", "--use-yarnrc"]),
};

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
  regexRule(
    "in-place editor",
    /\bsed\b[^\n\r]*\s-i(?:\b|["'])|\bperl\b[^\n\r]*(?:\s-pi\b|\s-p\b[^\n\r]*\s-i\b)/,
  ),
  {
    reason: "filesystem mutation command",
    input: "raw",
    matches: (command) => hasInlineInterpreterWriteCommand(command),
  },
  {
    reason: "shell redirection or tee write",
    input: "raw",
    matches: (command) => hasShellWriteRedirection(command),
  },
  {
    reason: "shell redirection or tee write",
    input: "raw",
    matches: (command) => hasTeeWriteCommand(command),
  },
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

    if (ch === "\r" || ch === "\n") {
      pushCurrent();
      tokens.push(";");
      index += ch === "\r" && next === "\n" ? 2 : 1;
      continue;
    }

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

    if (ch === "\\" && (next === "\n" || next === "\r")) {
      index += next === "\r" && command[index + 2] === "\n" ? 3 : 2;
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
        const attachedShortOption = !option.startsWith("--") && option.length > 2 ? option.slice(0, 2) : null;
        if (ENV_OPTIONS_WITH_VALUES.has(option)) {
          index += envToken.includes("=") ? 1 : 2;
          continue;
        }
        if (attachedShortOption && ENV_OPTIONS_WITH_VALUES.has(attachedShortOption)) {
          index += 1;
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

function hasShellWriteRedirection(command: string): boolean {
  let index = 0;

  while (index < command.length) {
    const ch = command[index];
    const next = command[index + 1];
    if (!ch) break;

    if (ch === "\\" && next) {
      index += next === "\r" && command[index + 2] === "\n" ? 3 : 2;
      continue;
    }

    if (ch === "$" && (next === "'" || next === "\"")) {
      const quoted = consumeQuotedShellToken(command, index + 2, next);
      index = quoted.endIndex;
      continue;
    }

    if (ch === "'" || ch === "\"" || ch === "`") {
      const quoted = consumeQuotedShellToken(command, index + 1, ch);
      index = quoted.endIndex;
      continue;
    }

    if (ch === "<" && next === ">") {
      index += 2;
      while (/\s/.test(command[index] ?? "")) index += 1;

      const target = command[index];
      if (!target) return false;
      if (command.slice(index).startsWith("/dev/null")) {
        index += "/dev/null".length;
        continue;
      }
      return true;
    }

    if (ch === ">" && command[index - 1] !== "<") {
      index += next === ">" ? 2 : 1;
      while (/\s/.test(command[index] ?? "")) index += 1;

      const target = command[index];
      if (!target) return false;
      if (target === "&") {
        const fdRedirect = command.slice(index + 1).match(/^\d+\b/);
        if (fdRedirect) {
          index += 1 + fdRedirect[0].length;
          continue;
        }
      }
      if (command.slice(index).startsWith("/dev/null")) {
        index += "/dev/null".length;
        continue;
      }
      return true;
    }

    index += 1;
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
        if (token === "/dev/null") {
          continue;
        }
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
    if (!GIT_READ_ONLY_SUBCOMMANDS.has(subcommand)) {
      return true;
    }
  }

  return false;
}

function findPackageManagerSubcommandIndex(segment: string[], executableIndex: number, executable: string): number {
  const optionsWithValues = PACKAGE_MANAGER_OPTIONS_WITH_VALUES[executable] ?? new Set<string>();
  let index = executableIndex + 1;

  while (index < segment.length) {
    const token = segment[index]?.toLowerCase();
    if (!token) break;
    if (token === "--") {
      index += 1;
      break;
    }
    if (token.startsWith("-") && token !== "-") {
      const option = token.split("=")[0] ?? token;
      if (optionsWithValues.has(option) && !token.includes("=")) {
        index += 2;
      } else {
        index += 1;
      }
      continue;
    }
    return index;
  }

  return index;
}

function hasPackageInstallCommand(command: string): boolean {
  for (const segment of splitShellCommandIntoSegments(command)) {
    const executableIndex = findSegmentExecutableIndex(segment);
    if (executableIndex < 0) continue;

    const executable = getShellTokenBaseName(segment[executableIndex] ?? "");
    const subcommandIndex = ["npm", "pnpm", "yarn", "bun"].includes(executable)
      ? findPackageManagerSubcommandIndex(segment, executableIndex, executable)
      : executableIndex + 1;
    const firstArg = segment[subcommandIndex]?.toLowerCase();
    const secondArg = segment[subcommandIndex + 1]?.toLowerCase();

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
    if (executable === "pip" || executable === "pip3") {
      const pipSubcommandIndex = findPackageManagerSubcommandIndex(segment, executableIndex, "pip");
      const pipSubcommand = segment[pipSubcommandIndex]?.toLowerCase();
      if (pipSubcommand === "install") {
        return true;
      }
    }
    if (["python", "python3", "py"].includes(executable)) {
      const pipExecutableIndex = findPythonSubcommandIndex(segment, executableIndex);
      const pipSubcommand = segment[pipExecutableIndex]?.toLowerCase();
      if (pipSubcommand === "pip") {
        const pipSubcommandIndex = findPackageManagerSubcommandIndex(segment, pipExecutableIndex, "pip");
        const pipInstallSubcommand = segment[pipSubcommandIndex]?.toLowerCase();
        if (pipInstallSubcommand === "install") {
          return true;
        }
      }
      continue;
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

function findPythonSubcommandIndex(segment: string[], executableIndex: number): number {
  let index = executableIndex + 1;

  while (index < segment.length) {
    const token = segment[index];
    if (!token) break;

    if (token === "--") {
      return index + 1;
    }
    if (!token.startsWith("-") || token === "-") {
      return index;
    }

    const normalizedArg = token.toLowerCase();
    if (normalizedArg === "-m") {
      return index + 1;
    }
    if (normalizedArg.startsWith("-m=")) {
      return index + 1;
    }
    if (normalizedArg.startsWith("-c")) {
      return segment.length;
    }

    index += 1;
  }

  return index;
}

function stripSingleAndDoubleQuotedSegments(command: string): string {
  return command.replace(/"(?:\\.|[^"\\])*"|'[^']*'/g, " ");
}

function extractCommandSubstitutionSegments(command: string): string[] {
  const segments: string[] = [];
  const re = /\$\(((?:\\.|[^()\\])*)\)|`((?:\\.|[^`\\])*)`/g;
  let match: RegExpExecArray | null = null;

  while ((match = re.exec(command)) !== null) {
    const segment = ((match[1] ?? match[2] ?? "").replace(/\\`/g, "`")).trim();
    if (segment) segments.push(segment);
  }

  return segments;
}

function extractEnvSplitStringSegments(command: string): string[] {
  const segments: string[] = [];

  for (const commandSegment of splitShellCommandIntoSegments(command)) {
    let index = 0;
    while (index < commandSegment.length && isEnvAssignmentToken(commandSegment[index] ?? "")) {
      index += 1;
    }
    if (getShellTokenBaseName(commandSegment[index] ?? "") !== "env") continue;

    for (let j = index + 1; j < commandSegment.length; j += 1) {
      const arg = commandSegment[j];
      const normalizedArg = arg?.toLowerCase();
      if (!normalizedArg) break;
      if (normalizedArg === "--") break;
      if (normalizedArg === "-s" || normalizedArg === "--split-string") {
        const splitString = commandSegment[j + 1]?.trim();
        if (splitString) segments.push(splitString);
        break;
      }
      if (normalizedArg.startsWith("--split-string=")) {
        const splitString = arg.slice(arg.indexOf("=") + 1).trim();
        if (splitString) segments.push(unwrapShellTokenValue(splitString));
        break;
      }
      if (!normalizedArg.startsWith("-")) break;
      if (!arg.includes("=")) {
        const option = normalizedArg.split("=")[0] ?? normalizedArg;
        const attachedShortOption = !option.startsWith("--") && option.length > 2 ? option.slice(0, 2) : null;
        if (ENV_OPTIONS_WITH_VALUES.has(option)) {
          j += 1;
        } else if (attachedShortOption && ENV_OPTIONS_WITH_VALUES.has(attachedShortOption)) {
          continue;
        }
      }
    }
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
    if (getShellTokenBaseName(commandSegment[launcherIndex] ?? "") === "eval") {
      const evalPayload = commandSegment.slice(launcherIndex + 1).join(" ").trim();
      if (evalPayload) segments.push(evalPayload);
      continue;
    }
    if (!isShellCommandLauncherToken(commandSegment[launcherIndex] ?? "")) continue;
    const launcherBaseName = getShellTokenBaseName(commandSegment[launcherIndex] ?? "");
    const optionsWithValues = SHELL_LAUNCHER_OPTIONS_WITH_VALUES[launcherBaseName];

    for (let j = launcherIndex + 1; j < commandSegment.length; j += 1) {
      const arg = commandSegment[j];
      const normalizedArg = arg?.toLowerCase();
      if (!normalizedArg) break;
      let hasStandaloneCFlag = false;

      if (normalizedArg.startsWith("--command=") || normalizedArg.startsWith("-command=")) {
        const inlineSegment = arg.slice(arg.indexOf("=") + 1).trim();
        if (inlineSegment) segments.push(unwrapShellTokenValue(inlineSegment));
        break;
      }

      const rawOption = arg.split("=")[0] ?? arg;
      const option = normalizedArg.split("=")[0] ?? normalizedArg;
      if (optionsWithValues?.has(rawOption) || optionsWithValues?.has(option)) {
        if (!arg.includes("=")) {
          j += 1;
        }
        continue;
      }

      if (/^-[a-z]{2,}$/i.test(normalizedArg) && normalizedArg.includes("c")) {
        const compactFlags = normalizedArg.slice(1);
        const cIndex = compactFlags.indexOf("c");
        if (cIndex !== -1 && cIndex < compactFlags.length - 1) {
          const trailingFlags = compactFlags.slice(cIndex + 1).split("");
          if (trailingFlags.every((flag) => SHELL_SHORT_NO_VALUE_COMMAND_FLAGS.has(flag))) {
            hasStandaloneCFlag = true;
            // Combined short flags (e.g., -ce) should treat the next token as the command payload.
          }
        }
      }

      if (SHELL_COMMAND_ARG_FLAGS.has(normalizedArg) || /^-[a-z]*c$/i.test(normalizedArg) || hasStandaloneCFlag) {
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

function hasInlineInterpreterWriteCommand(command: string): boolean {
  for (const segment of splitShellCommandIntoSegments(command)) {
    if (isInlineInterpreterInvocationSegment(segment)) {
      return true;
    }
  }

  return false;
}

function isInlineInterpreterInvocationSegment(segment: string[]): boolean {
  const executableIndex = findSegmentExecutableIndex(segment);
  if (executableIndex < 0) return false;

  const executable = getShellTokenBaseName(segment[executableIndex] ?? "");
  if (!INLINE_INTERPRETER_COMMANDS.has(executable)) {
    return false;
  }

  for (let index = executableIndex + 1; index < segment.length; index += 1) {
    const token = segment[index];
    if (!token) continue;

    if (token === "--") {
      break;
    }

    const normalizedToken = token.toLowerCase();
    if (normalizedToken === "--command" || normalizedToken === "--eval") {
      return true;
    }
    if (normalizedToken === "-c" || normalizedToken === "-e") {
      return true;
    }
    if (
      (normalizedToken.startsWith("-c") && normalizedToken !== "-c")
      || (normalizedToken.startsWith("-e") && normalizedToken !== "-e")
    ) {
      return true;
    }
    if (normalizedToken === "-" && (segment[index + 1]?.startsWith("<<") ?? false)) {
      return true;
    }
    if (normalizedToken.startsWith("<<")) {
      return true;
    }
    if (!normalizedToken.startsWith("-") || normalizedToken === "-") {
      break;
    }
  }

  return false;
}

function extractInlineInterpreterCommandStringSegments(command: string): string[] {
  const segments: string[] = [];

  for (const commandSegment of splitShellCommandIntoSegments(command)) {
    if (!isInlineInterpreterInvocationSegment(commandSegment)) {
      continue;
    }
    segments.push(commandSegment.join(" "));
  }

  return segments;
}

function normalizeShellCommandForPolicy(command: string): string {
  return command.toLowerCase().replace(/\s+/g, " ").trim();
}

function buildTopLevelPolicyCandidate(command: string): string {
  return stripCommandSubstitutionSegments(stripSingleAndDoubleQuotedSegments(command));
}

function collectShellPolicyCandidates(command: string): string[] {
  const candidates = new Map<string, string>();
  const pending = [command];
  const enqueueCandidate = (candidate: string) => {
    const key = normalizeShellCommandForPolicy(candidate);
    if (!key || candidates.has(key) || pending.includes(candidate)) return;
    pending.push(candidate);
  };

  while (pending.length > 0) {
    const candidate = pending.shift();
    if (!candidate) continue;

    const key = normalizeShellCommandForPolicy(candidate);
    if (!key || candidates.has(key)) continue;
    candidates.set(key, candidate);

    const executedSegments = [
      ...extractCommandSubstitutionSegments(candidate),
      ...extractEnvSplitStringSegments(candidate),
      ...extractShellCommandStringSegments(candidate),
      ...extractInlineInterpreterCommandStringSegments(candidate),
    ];
    for (const segment of executedSegments) {
      enqueueCandidate(segment);
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
      const policyInput =
        rule.input === "raw"
          ? candidate.trim()
          : normalizeShellCommandForPolicy(buildTopLevelPolicyCandidate(candidate));
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
