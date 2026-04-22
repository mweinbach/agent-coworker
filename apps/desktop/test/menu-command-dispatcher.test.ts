import { describe, expect, test } from "bun:test";

import { createMenuCommandDispatcher } from "../electron/services/menuCommandDispatcher";

describe("menu command dispatcher", () => {
  test("queues commands until a renderer is ready", () => {
    const dispatcher = createMenuCommandDispatcher();

    dispatcher.dispatch("openSettings", null);
    dispatcher.dispatch("newThread", null);

    expect(dispatcher.drainPending()).toEqual(["openSettings", "newThread"]);
    expect(dispatcher.drainPending()).toEqual([]);
  });

  test("sends immediately when a renderer is already available", () => {
    const dispatcher = createMenuCommandDispatcher();
    const sent: string[] = [];

    dispatcher.dispatch("openUpdates", {
      send(command) {
        sent.push(command);
      },
    });

    expect(sent).toEqual(["openUpdates"]);
    expect(dispatcher.drainPending()).toEqual([]);
  });
});
