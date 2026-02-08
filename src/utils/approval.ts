export const AUTO_APPROVE_PATTERNS: RegExp[] = [
  /^ls\b/,
  /^pwd$/,
  /^echo\b/,
  /^cat\b/,
  /^head\b/,
  /^tail\b/,
  /^which\b/,
  /^type\b/,
  /^man\b/,
  /^git\s+(status|log|diff|branch)\b/,
  /^node\s+--version$/,
  /^bun\s+--version$/,
];

export const ALWAYS_WARN_PATTERNS: RegExp[] = [
  /\brm\s+-rf\b/,
  /\bgit\s+push\s+--force\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bchmod\b/,
  /\bchown\b/,
  /\bsudo\b/,
  /\bcurl\b.*\|\s*bash/,
  /\bdrop\s+table\b/i,
  /\bdelete\s+from\b/i,
];

export type CommandApprovalClassification =
  | { kind: "auto" }
  | { kind: "prompt"; dangerous: boolean };

function hasShellControlOperators(command: string): boolean {
  // Conservative: if the command contains obvious shell control operators or
  // redirections, don't auto-approve even if it starts with a "safe" command.
  // This avoids cases like: `ls; rm -rf /`.
  return (
    command.includes("\n") ||
    command.includes("\r") ||
    command.includes(";") ||
    command.includes("&&") ||
    command.includes("||") ||
    command.includes("|") ||
    command.includes(">") ||
    command.includes("<") ||
    command.includes("`") ||
    command.includes("$(") ||
    command.includes("&")
  );
}

export function classifyCommand(command: string): CommandApprovalClassification {
  const dangerous = ALWAYS_WARN_PATTERNS.some((p) => p.test(command));
  if (dangerous) return { kind: "prompt", dangerous: true };

  if (!hasShellControlOperators(command) && AUTO_APPROVE_PATTERNS.some((p) => p.test(command))) {
    return { kind: "auto" };
  }
  return { kind: "prompt", dangerous };
}

export async function approveCommand(
  command: string,
  prompt: (message: string) => Promise<string>
): Promise<boolean> {
  const classification = classifyCommand(command);
  if (classification.kind === "auto") return true;

  const prefix = classification.dangerous ? "DANGEROUS: " : "Run: ";
  const answer = await prompt(`${prefix}${command}\nApprove? [y/N] `);
  return answer.trim().toLowerCase() === "y";
}
