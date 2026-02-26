import { describe, expect, test } from "bun:test";

import { persistedStateInputSchema } from "../src/lib/desktopSchemas";

const TS = "2024-01-01T00:00:00.000Z";

describe("desktop persisted-state schema defaults", () => {
  test("defaults workspace booleans when omitted", () => {
    const parsed = persistedStateInputSchema.parse({
      version: 2,
      workspaces: [
        {
          id: "ws_1",
          name: "Workspace",
          path: "/tmp/workspace",
          createdAt: TS,
          lastOpenedAt: TS,
        },
      ],
      threads: [],
    });

    expect(parsed.workspaces[0]?.defaultEnableMcp).toBe(true);
    expect(parsed.workspaces[0]?.yolo).toBe(false);
    expect(parsed.developerMode).toBe(false);
    expect(parsed.showHiddenFiles).toBe(false);
  });

  test("keeps explicit workspace booleans", () => {
    const parsed = persistedStateInputSchema.parse({
      version: 2,
      workspaces: [
        {
          id: "ws_1",
          name: "Workspace",
          path: "/tmp/workspace",
          createdAt: TS,
          lastOpenedAt: TS,
          defaultEnableMcp: false,
          yolo: true,
        },
      ],
      threads: [],
      developerMode: true,
      showHiddenFiles: true,
    });

    expect(parsed.workspaces[0]?.defaultEnableMcp).toBe(false);
    expect(parsed.workspaces[0]?.yolo).toBe(true);
    expect(parsed.developerMode).toBe(true);
    expect(parsed.showHiddenFiles).toBe(true);
  });
});
