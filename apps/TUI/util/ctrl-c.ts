export type CtrlCOutcome = "clear_input" | "confirm_exit" | "exit";

export function resolveCtrlCAction(
  input: string,
  pendingAt: number | null,
  now: number,
  windowMs = 1500
): { outcome: CtrlCOutcome; nextPendingAt: number | null } {
  if (input.length > 0) {
    return { outcome: "clear_input", nextPendingAt: null };
  }

  if (pendingAt !== null && now - pendingAt < windowMs) {
    return { outcome: "exit", nextPendingAt: null };
  }

  return { outcome: "confirm_exit", nextPendingAt: now };
}
