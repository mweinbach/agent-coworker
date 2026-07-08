import { classifyCommand } from "../platform/approval";
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
// surface the obviously-destructive cases to the user.
//
// The pattern tables live in src/platform/approval.ts, keyed by the shell
// dialect the host actually runs (PowerShell on win32, POSIX sh elsewhere), so
// `Remove-Item -Recurse -Force` prompts on the platform whose sessions are
// steered into PowerShell. The POSIX destructive vocabulary remains a shared
// floor on every platform.
export function classifyCommandDetailed(command: string): CommandApprovalClassification {
  const { risk } = classifyCommand(command);
  if (risk === "dangerous") {
    return { autoApprove: false, dangerous: true, reasonCode: "matches_dangerous_pattern" };
  }
  if (risk === "review") {
    return { autoApprove: false, dangerous: false, reasonCode: "requires_manual_review" };
  }
  return { autoApprove: true, dangerous: false, reasonCode: "safe_auto_approved" };
}
