import { describe, expect, test } from "bun:test";

import { ASK_SKIP_TOKEN } from "../../../../src/shared/ask";
import { resolveAskEscapeAnswer } from "./question";

describe("TUI ask prompt", () => {
  test("maps Escape to explicit skip token", () => {
    expect(resolveAskEscapeAnswer()).toBe(ASK_SKIP_TOKEN);
  });
});
