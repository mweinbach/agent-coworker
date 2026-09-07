import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { getEventListeners } from "node:events";
import { createPiRequestBudget, resolvePiRequestPolicy } from "../src/runtime/pi/requestBudget";

describe("PI request policy", () => {
  test("bounds the transport timeout by the logical step deadline", () => {
    expect(resolvePiRequestPolicy({ timeoutMs: 500, stepTimeoutMs: 100 })).toEqual({
      timeoutMs: 100,
      stepTimeoutMs: 100,
      maxRetries: 0,
      maxRetryDelayMs: 10_000,
    });
  });

  for (const key of ["timeoutMs", "stepTimeoutMs", "maxRetryDelayMs", "maxRetries"]) {
    for (const value of [Infinity, -Infinity, NaN, -1, 0.5, "100", null]) {
      test(`rejects ${key}=${String(value)} instead of disabling its bound`, () => {
        expect(() => resolvePiRequestPolicy({ [key]: value })).toThrow(RangeError);
      });
    }
  }

  test("rejects timer overflow, disabled deadlines, and nested SDK retries", () => {
    for (const options of [
      { timeoutMs: 600_001 },
      { stepTimeoutMs: 1_800_001 },
      { maxRetryDelayMs: 60_001 },
      { timeoutMs: 0 },
      { stepTimeoutMs: 0 },
      { maxRetries: 1 },
    ]) {
      expect(() => resolvePiRequestPolicy(options)).toThrow(RangeError);
    }
    expect(resolvePiRequestPolicy({ maxRetryDelayMs: 0 }).maxRetryDelayMs).toBe(0);
    expect(() => createPiRequestBudget({ stepTimeoutMs: Infinity })).toThrow(RangeError);
    expect(() => createPiRequestBudget({ stepTimeoutMs: -1 })).toThrow(RangeError);
  });
});

describe("PI logical model-step request budget", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test("terminates a stalled provider that ignores abort and consumes late rejection", async () => {
    const caller = new AbortController();
    const budget = createPiRequestBudget({ signal: caller.signal, stepTimeoutMs: 100 });
    let rejectProvider!: (reason: unknown) => void;
    const provider = new Promise<void>((_resolve, reject) => {
      rejectProvider = reject;
    });
    const outcome = budget.run(() => provider).catch((error: unknown) => error);
    try {
      jest.advanceTimersByTime(100);
      const error = await outcome;
      expect(error).toBeInstanceOf(DOMException);
      expect((error as DOMException).name).toBe("TimeoutError");
      expect(budget.signal.reason).toBe(error);
      expect(caller.signal.aborted).toBe(false);
      expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
      expect(getEventListeners(budget.signal, "abort")).toHaveLength(0);
      rejectProvider(new Error("late provider rejection"));
      await Promise.resolve();
    } finally {
      budget.dispose();
    }
    expect(jest.getTimerCount()).toBe(0);
  });

  test("shares a single deadline across attempts and backoff", async () => {
    const budget = createPiRequestBudget({ stepTimeoutMs: 100 });
    try {
      await budget.run(() => "first attempt");
      jest.advanceTimersByTime(60);
      const backoff = budget.sleep(30);
      jest.advanceTimersByTime(30);
      await backoff;
      const secondAttempt = budget
        .run(() => new Promise<void>(() => {}))
        .catch((error: unknown) => error);
      jest.advanceTimersByTime(10);
      expect(((await secondAttempt) as DOMException).name).toBe("TimeoutError");
      let invoked = false;
      await expect(
        budget.run(() => {
          invoked = true;
        }),
      ).rejects.toMatchObject({ name: "TimeoutError" });
      expect(invoked).toBe(false);
    } finally {
      budget.dispose();
    }
    expect(jest.getTimerCount()).toBe(0);
  });

  test("cancels backoff immediately on caller abort and clears both timers", async () => {
    const caller = new AbortController();
    const budget = createPiRequestBudget({ signal: caller.signal, stepTimeoutMs: 100 });
    const reason = new Error("caller cancelled");
    try {
      const backoff = budget.sleep(60).catch((error: unknown) => error);
      expect(jest.getTimerCount()).toBe(2);
      caller.abort(reason);
      expect(await backoff).toBe(reason);
      expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
      expect(getEventListeners(budget.signal, "abort")).toHaveLength(0);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      budget.dispose();
    }
  });

  test("deadline also bounds a stalled injected backoff implementation", async () => {
    const budget = createPiRequestBudget({ stepTimeoutMs: 100 });
    try {
      const backoff = budget
        .run(() => new Promise<void>(() => {}))
        .catch((error: unknown) => error);
      jest.advanceTimersByTime(100);
      expect(((await backoff) as DOMException).name).toBe("TimeoutError");
    } finally {
      budget.dispose();
    }
  });

  test("pre-aborted caller starts no work, listeners, or timers", async () => {
    const caller = new AbortController();
    caller.abort();
    const budget = createPiRequestBudget({ signal: caller.signal });
    let invoked = false;
    try {
      await expect(
        budget.run(() => {
          invoked = true;
        }),
      ).rejects.toBe(caller.signal.reason);
      await expect(budget.sleep(1)).rejects.toBe(caller.signal.reason);
      expect(() => budget.throwIfAborted()).toThrow();
      expect(invoked).toBe(false);
      expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      budget.dispose();
    }
  });

  test("cleans listeners for success, synchronous throws, and consumer rejection", async () => {
    const caller = new AbortController();
    const budget = createPiRequestBudget({ signal: caller.signal });
    const failure = new Error("consumer failure");
    try {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        expect(await budget.run((signal) => signal)).toBe(budget.signal);
        await expect(
          budget.run(() => {
            throw failure;
          }),
        ).rejects.toBe(failure);
        await expect(budget.run(() => Promise.reject(failure))).rejects.toBe(failure);
        expect(getEventListeners(budget.signal, "abort")).toHaveLength(0);
        expect(getEventListeners(caller.signal, "abort")).toHaveLength(1);
      }
    } finally {
      budget.dispose();
      budget.dispose();
    }
    expect(caller.signal.aborted).toBe(false);
    expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  test("dispose cancels outstanding work and prevents reuse", async () => {
    const budget = createPiRequestBudget();
    const result = budget.run(() => new Promise<void>(() => {})).catch((error: unknown) => error);
    budget.dispose();
    expect(((await result) as DOMException).name).toBe("AbortError");
    await expect(budget.run(() => "too late")).rejects.toMatchObject({ name: "AbortError" });
    expect(jest.getTimerCount()).toBe(0);
  });
});
