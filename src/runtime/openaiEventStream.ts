export class EventStream<TEvent, TResult> {
  private readonly queue: TEvent[] = [];
  private readonly waiting: Array<(value: IteratorResult<TEvent>) => void> = [];
  private readonly finalResultPromise: Promise<TResult>;
  private resolveFinalResult!: (value: TResult) => void;
  private done = false;

  constructor(
    private readonly isComplete: (event: TEvent) => boolean,
    private readonly extractResult: (event: TEvent) => TResult,
  ) {
    this.finalResultPromise = new Promise<TResult>((resolve) => {
      this.resolveFinalResult = resolve;
    });
  }

  push(event: TEvent) {
    if (this.done) return;
    if (this.isComplete(event)) {
      this.done = true;
      this.resolveFinalResult(this.extractResult(event));
    }

    const waiter = this.waiting.shift();
    if (waiter) {
      waiter({ value: event, done: false });
      return;
    }

    this.queue.push(event);
  }

  end(result?: TResult) {
    this.done = true;
    if (result !== undefined) {
      this.resolveFinalResult(result);
    }
    while (this.waiting.length > 0) {
      const waiter = this.waiting.shift();
      waiter?.({ value: undefined, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterableIterator<TEvent> {
    while (true) {
      if (this.queue.length > 0) {
        const next = this.queue.shift();
        if (next !== undefined) yield next;
        continue;
      }
      if (this.done) return;

      const result = await new Promise<IteratorResult<TEvent>>((resolve) =>
        this.waiting.push(resolve),
      );
      if (result.done) return;
      yield result.value;
    }
  }

  result(): Promise<TResult> {
    return this.finalResultPromise;
  }
}

export class AssistantMessageEventStream extends EventStream<any, any> {
  constructor() {
    super(
      (event) => event?.type === "done" || event?.type === "error",
      (event) => {
        if (event?.type === "done") return event.message;
        if (event?.type === "error") return event.error;
        throw new Error("Unexpected event type for final result");
      },
    );
  }
}
