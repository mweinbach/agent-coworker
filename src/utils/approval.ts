import type { ApprovalRiskCode } from "../types";

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

export type CommandApprovalClassificationDetailed =
  | { kind: "auto"; dangerous: false; riskCode: "safe_auto_approved" }
  | {
      kind: "prompt";
      dangerous: boolean;
      riskCode: Exclude<ApprovalRiskCode, "safe_auto_approved">;
    };

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
  const detailed = classifyCommandDetailed(command);
  if (detailed.kind === "auto") return { kind: "auto" };
  return { kind: "prompt", dangerous: detailed.dangerous };
}

export function classifyCommandDetailed(command: string): CommandApprovalClassificationDetailed {
  const dangerous = ALWAYS_WARN_PATTERNS.some((p) => p.test(command));
  if (dangerous) {
    return { kind: "prompt", dangerous: true, riskCode: "matches_dangerous_pattern" };
  }

  if (hasShellControlOperators(command)) {
    return { kind: "prompt", dangerous: false, riskCode: "contains_shell_control_operator" };
  }

  if (AUTO_APPROVE_PATTERNS.some((p) => p.test(command))) {
    return { kind: "auto", dangerous: false, riskCode: "safe_auto_approved" };
  }

  return { kind: "prompt", dangerous: false, riskCode: "requires_manual_review" };
}

export async function approveCommand(
  command: string,
  prompt: (message: string) => Promise<string>
): Promise<boolean> {
  const classification = classifyCommandDetailed(command);
  if (classification.kind === "auto") return true;

  const prefix = classification.dangerous ? "DANGEROUS: " : "Run: ";
  const answer = await prompt(
    `${prefix}${command}\nRisk: ${classification.riskCode}\nApprove? [y/N] `
  );
  return answer.trim().toLowerCase() === "y";
}
