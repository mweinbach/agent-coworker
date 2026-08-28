export class CliStreamState {
  private readonly assistantTextByTurn = new Map<string, string>();
  private readonly assistantOpenTurns = new Set<string>();
  private readonly reasoningTurns = new Set<string>();

  reset() {
    this.assistantTextByTurn.clear();
    this.assistantOpenTurns.clear();
    this.reasoningTurns.clear();
  }

  appendAssistantDelta(turnId: string, text: string): string {
    const next = `${this.assistantTextByTurn.get(turnId) ?? ""}${text}`;
    this.assistantTextByTurn.set(turnId, next);
    return next;
  }

  getAssistantText(turnId: string): string {
    return this.assistantTextByTurn.get(turnId) ?? "";
  }

  openAssistantTurn(turnId: string): boolean {
    if (this.assistantOpenTurns.has(turnId)) return false;
    this.assistantOpenTurns.add(turnId);
    return true;
  }

  closeAssistantTurn(turnId: string): boolean {
    return this.assistantOpenTurns.delete(turnId);
  }

  markReasoningTurn(turnId: string) {
    this.reasoningTurns.add(turnId);
  }

  hasReasoningTurn(turnId: string): boolean {
    return this.reasoningTurns.has(turnId);
  }
}
