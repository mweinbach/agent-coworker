export class CliStreamState {
  private readonly assistantTextByTurn = new Map<string, string>();
  private readonly assistantOpenTurns = new Set<string>();
  private readonly reasoningTurns = new Set<string>();
  private readonly toolInputByKey = new Map<string, string>();

  reset() {
    this.assistantTextByTurn.clear();
    this.assistantOpenTurns.clear();
    this.reasoningTurns.clear();
    this.toolInputByKey.clear();
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

  setToolInput(turnId: string, chunkIndex: number, value: string) {
    this.toolInputByKey.set(`${turnId}:${chunkIndex}`, value);
  }

  appendToolInput(turnId: string, chunkIndex: number, delta: string) {
    const key = `${turnId}:${chunkIndex}`;
    const current = this.toolInputByKey.get(key) ?? "";
    this.toolInputByKey.set(key, `${current}${delta}`);
  }

  appendToolInputForKey(key: string, delta: string) {
    const current = this.toolInputByKey.get(key) ?? "";
    this.toolInputByKey.set(key, `${current}${delta}`);
  }

  getToolInput(turnId: string, chunkIndex: number): string | undefined {
    return this.toolInputByKey.get(`${turnId}:${chunkIndex}`);
  }

  getToolInputForKey(key: string): string | undefined {
    return this.toolInputByKey.get(key);
  }
}
