export function shouldSuspendGlobalHotkeys(state: {
  pendingAsk: boolean;
  pendingApproval: boolean;
}): boolean {
  return state.pendingAsk || state.pendingApproval;
}
