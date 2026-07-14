import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import { canonicalizeSync } from "../src/platform/paths";
import { scratchRoots } from "../src/platform/sandbox";
import { WorkspaceFileChangeMonitor } from "../src/server/runtime/WorkspaceFileChangeMonitor";
import type { WorkspaceFileChangeEvent } from "../src/shared/fileVersion";

async function waitForEvent(
  events: WorkspaceFileChangeEvent[],
  predicate: (event: WorkspaceFileChangeEvent) => boolean,
): Promise<WorkspaceFileChangeEvent> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 2_000) {
    const event = events.find(predicate);
    if (event) return event;
    await Bun.sleep(10);
  }
  throw new Error("Timed out waiting for a workspace file change event.");
}

describe("WorkspaceFileChangeMonitor", () => {
  test("reports an external file change with its new canonical version", async () => {
    const dir = await fs.mkdtemp(path.join(scratchRoots()[0] ?? "/tmp", "cowork-file-monitor-"));
    const filePath = path.join(dir, "external.md");
    await fs.writeFile(filePath, "old", "utf8");
    const events: WorkspaceFileChangeEvent[] = [];
    const monitor = new WorkspaceFileChangeMonitor({
      cwd: dir,
      debounceMs: 5,
      onChange: (event) => {
        events.push(event);
      },
    });

    try {
      await fs.writeFile(filePath, "replacement", "utf8");
      const canonicalFilePath = canonicalizeSync(filePath);
      const event = await waitForEvent(
        events,
        (candidate) => candidate.kind === "changed" && candidate.path === canonicalFilePath,
      );

      expect(event.kind).toBe("changed");
      if (event.kind === "changed") {
        expect(event.version.size).toBe("replacement".length);
      }
    } finally {
      monitor.stop();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
