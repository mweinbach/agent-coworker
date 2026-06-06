import type { ApprovalRiskCode } from "../types";

export interface CommandApprovalClassification {
  autoApprove: boolean;
  dangerous: boolean;
  reasonCode: ApprovalRiskCode;
}

const DANGEROUS_PATTERNS: RegExp[] = [
  /\brm\s+-(?:[^\s]*r[^\s]*f|[^\s]*f[^\s]*r)\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\b(?=.*\s-[^\s]*f)(?=.*\s-[^\s]*d)/i,
  /\bgit\s+push\b.*(?:--force(?:-with-lease)?|\s-f(?:\s|$))/i,
  /\b(?:curl|wget)\b[\s\S]*\|\s*(?:sudo\s+)?(?:ba|z|c)?sh\b/i,
  /\bdd\b(?=.*\bof=)/i,
];

const REVIEW_PATTERNS: RegExp[] = [
  /\brm\b/i,
  /\bgit\s+push\b/i,
  /\bnpm\s+publish\b/i,
  /\b(?:cat|less|more|tail|head)\s+(?:\/etc\/shadow|[^;&|]*\.ssh\/)/i,
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
