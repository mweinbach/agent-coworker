import type { ApprovalRiskCode } from "../types";

export interface CommandApprovalClassification {
  autoApprove: boolean;
  dangerous: boolean;
  reasonCode: ApprovalRiskCode;
}

// IMPORTANT: this classifier is a UX gate ("should we ask the human?"), NOT a
// security boundary. The OS sandbox (src/platform/sandbox) is what actually
// confines a command's filesystem/network reach, and it is applied to every bash
// invocation regardless of the result here (see src/tools/bash.ts). So
// `autoApprove: true` means only "no prompt needed because the sandbox will
// contain it" — never "this command is safe." Do not move security-critical
// decisions into these regexes: a determined model can always express a
// destructive action in a form no pattern anticipates (interpreters, generated
// scripts run on a later call, novel tools). These patterns exist purely to
// surface the obviously-destructive cases to the user. Note the whole command
// string is scanned, so a dangerous token inside `eval "..."`, `bash -c "..."`,
// `find -exec rm -rf`, `\rm`, or `$RM` is already matched by its own token.
const DANGEROUS_PATTERNS: RegExp[] = [
  /\brm\s+-(?:[^\s]*r[^\s]*f|[^\s]*f[^\s]*r)\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\b(?=.*\s-[^\s]*f)(?=.*\s-[^\s]*d)/i,
  /\bgit\s+push\b.*(?:--force(?:-with-lease)?|\s-f(?:\s|$))/i,
  // Pipe-to-interpreter (curl … | sh). Cover the common shells/interpreters, not
  // just the (ba|z|c)?sh family.
  /\b(?:curl|wget)\b[\s\S]*\|\s*(?:sudo\s+)?(?:(?:ba|z|c|k|tc|da)?sh|fish|python\d?|perl|ruby|node)\b/i,
  /\bdd\b(?=.*\bof=)/i,
  // Destructive file/disk operations that carry no literal `rm` token.
  /\bfind\b[\s\S]*\s-delete\b/i,
  /\bshred\b/i,
  /\bmkfs(?:\.\w+)?\b/i,
  />\s*\/dev\/(?:sd|nvme|disk|hd|mapper)/i,
];

const REVIEW_PATTERNS: RegExp[] = [
  /\brm\b/i,
  /\bgit\s+push\b/i,
  /\bnpm\s+publish\b/i,
  /\b(?:cat|less|more|tail|head)\s+(?:\/etc\/shadow|[^;&|]*\.ssh\/)/i,
  // Recursive permission/ownership changes and explicit truncation are risky
  // enough to surface, but common enough that they stay "review", not "dangerous".
  /\bch(?:mod|own)\s+-[^\s]*R/i,
  /\btruncate\b/i,
];

export function classifyCommandDetailed(command: string): CommandApprovalClassification {
  const trimmed = command.trim();
  if (trimmed.length === 0) {
    return { autoApprove: true, dangerous: false, reasonCode: "safe_auto_approved" };
  }

  if (DANGEROUS_PATTERNS.some((pattern) => pattern.test(trimmed))) {
    return {
      autoApprove: false,
      dangerous: true,
      reasonCode: "matches_dangerous_pattern",
    };
  }

  if (REVIEW_PATTERNS.some((pattern) => pattern.test(trimmed))) {
    return {
      autoApprove: false,
      dangerous: false,
      reasonCode: "requires_manual_review",
    };
  }

  return { autoApprove: true, dangerous: false, reasonCode: "safe_auto_approved" };
}
