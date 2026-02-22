export class TurnExecutionManager {
  constructor(
    private readonly handlers: {
      sendUserMessage: (text: string, clientMessageId?: string, displayText?: string) => Promise<void>;
      handleAskResponse: (requestId: string, answer: string) => void;
      handleApprovalResponse: (requestId: string, approved: boolean) => void;
      cancel: () => void;
    }
  ) {}

  sendUserMessage(text: string, clientMessageId?: string, displayText?: string) {
    return this.handlers.sendUserMessage(text, clientMessageId, displayText);
  }

  handleAskResponse(requestId: string, answer: string) {
    this.handlers.handleAskResponse(requestId, answer);
  }

  handleApprovalResponse(requestId: string, approved: boolean) {
    this.handlers.handleApprovalResponse(requestId, approved);
  }

  cancel() {
    this.handlers.cancel();
  }
}
