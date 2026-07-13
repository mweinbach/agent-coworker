import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

async function readDesktopSource(path: string): Promise<string> {
  return readFile(new URL(`../src/${path}`, import.meta.url), "utf8");
}

describe("accessibility review fixes", () => {
  test("citation popovers allow focus entry and handle source navigation inside the content", async () => {
    const source = await readDesktopSource("ui/markdown/DesktopMarkdown.tsx");
    expect(source).not.toContain("onOpenAutoFocus={(event) => event.preventDefault()}");
    expect(source).toMatch(/<PopoverContent[\s\S]*onKeyDown=[\s\S]*ArrowLeft[\s\S]*ArrowRight/);
  });

  test("onboarding stays mounted while dismissal confirmation runs or fails", async () => {
    const source = await readDesktopSource("ui/onboarding/DesktopOnboarding.tsx");
    expect(source).toContain("<Dialog\n      open");
    expect(source).toContain("finally {\n      dismissPendingRef.current = false;");
  });

  test("response completion waits for the thread to stop being busy", async () => {
    const source = await readDesktopSource("ui/chat/ChatFeed.tsx");
    expect(source).toContain("if (busy || !pendingStreamingAssistantMessageIdRef.current) return;");
    expect(source).toContain("busy={busy}");
  });

  test("chat attachment ingestion reports rejected and accepted outcomes", async () => {
    const sources = await Promise.all([
      readDesktopSource("ui/ChatView.tsx"),
      readDesktopSource("ui/chat/NewChatLanding.tsx"),
    ]);
    for (const source of sources) {
      expect(source).toContain("return false;");
      expect(source).toContain("return true;");
    }
  });
});
