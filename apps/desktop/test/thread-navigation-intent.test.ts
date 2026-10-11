import { beforeEach, describe, expect, test } from "bun:test";

import {
  __internalOperationIntent,
  invalidateNavigationIntent,
  isThreadNavigationIntentCurrent,
  recordThreadNavigationIntent,
  rekeyThreadNavigationIntent,
} from "../src/app/store.helpers/operationIntent";

beforeEach(() => {
  __internalOperationIntent.reset();
});

describe("rekeyThreadNavigationIntent", () => {
  test("moves a thread's navigation authority onto its replacement id", () => {
    recordThreadNavigationIntent("optimistic");

    rekeyThreadNavigationIntent("optimistic", "remote");

    expect(isThreadNavigationIntentCurrent("optimistic")).toBe(false);
    expect(isThreadNavigationIntentCurrent("remote")).toBe(true);

    invalidateNavigationIntent();
    expect(isThreadNavigationIntentCurrent("remote")).toBe(false);
  });

  test("does not replace an intent the destination thread already has", () => {
    recordThreadNavigationIntent("remote");
    invalidateNavigationIntent();
    recordThreadNavigationIntent("optimistic");

    rekeyThreadNavigationIntent("optimistic", "remote");

    expect(isThreadNavigationIntentCurrent("optimistic")).toBe(false);
    expect(isThreadNavigationIntentCurrent("remote")).toBe(false);
  });

  test("leaves both ids untouched for a blank or identical rekey", () => {
    recordThreadNavigationIntent("kept");

    rekeyThreadNavigationIntent("", "kept");
    rekeyThreadNavigationIntent("kept", "");
    rekeyThreadNavigationIntent("kept", "kept");
    rekeyThreadNavigationIntent("missing", "fresh");

    expect(isThreadNavigationIntentCurrent("kept")).toBe(true);
    expect(isThreadNavigationIntentCurrent("fresh")).toBe(false);
  });
});
