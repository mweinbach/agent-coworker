import { describe, expect, mock, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { NoopJsonRpcSocket } from "./helpers/jsonRpcSocketMock";
import { createDesktopCommandsMock } from "./helpers/mockDesktopCommands";
import { setupJsdom } from "./jsdomHarness";

const MOCK_SYSTEM_APPEARANCE = {
  platform: "linux",
  themeSource: "system",
  shouldUseDarkColors: false,
  shouldUseHighContrastColors: false,
  shouldUseInvertedColorScheme: false,
  prefersReducedTransparency: false,
  inForcedColorsMode: false,
};

mock.module("../src/lib/desktopCommands", () =>
  createDesktopCommandsMock({
    getSystemAppearance: async () => MOCK_SYSTEM_APPEARANCE,
    setWindowAppearance: async () => MOCK_SYSTEM_APPEARANCE,
    onSystemAppearanceChanged: () => () => {},
  }),
);

mock.module("../src/lib/agentSocket", () => ({
  JsonRpcSocket: NoopJsonRpcSocket,
}));

let capturedStreamdownProps: Record<string, unknown>[] = [];

// Clean mock of streamdown without self-import circularity
mock.module("streamdown", () => ({
  defaultRemarkPlugins: { gfm: () => {} },
  defaultRehypePlugins: { raw: () => {}, harden: () => {} },
  Streamdown: (props: Record<string, unknown>) => {
    capturedStreamdownProps.push(props);
    return createElement("div", { "data-testid": "streamdown-mock" }, props.children as any);
  },
}));

const { DesktopMarkdown } = await import("../src/ui/markdown/DesktopMarkdown");

describe("Streamdown props reference stability across token deltas", () => {
  test("plugins, components, remarkPlugins, rehypePlugins, controls, and mermaid remain reference-equal when children streams in", async () => {
    capturedStreamdownProps = [];
    const harness = setupJsdom();
    try {
      const container = document.createElement("div");
      document.body.appendChild(container);
      const root = createRoot(container);

      // Token 1 delta
      await act(async () => {
        root.render(
          createElement(DesktopMarkdown, {
            children: "Hello",
          }),
        );
      });

      // Token 2 delta
      await act(async () => {
        root.render(
          createElement(DesktopMarkdown, {
            children: "Hello world",
          }),
        );
      });

      // Token 3 delta
      await act(async () => {
        root.render(
          createElement(DesktopMarkdown, {
            children: "Hello world! Streaming token deltas arrive.",
          }),
        );
      });

      expect(capturedStreamdownProps.length).toBe(3);

      const render1 = capturedStreamdownProps[0];
      const render2 = capturedStreamdownProps[1];
      const render3 = capturedStreamdownProps[2];

      // Verify reference equality across token deltas
      expect(render1.plugins).toBe(render2.plugins);
      expect(render2.plugins).toBe(render3.plugins);

      expect(render1.components).toBe(render2.components);
      expect(render2.components).toBe(render3.components);

      expect(render1.remarkPlugins).toBe(render2.remarkPlugins);
      expect(render2.remarkPlugins).toBe(render3.remarkPlugins);

      expect(render1.rehypePlugins).toBe(render2.rehypePlugins);
      expect(render2.rehypePlugins).toBe(render3.rehypePlugins);

      expect(render1.controls).toBe(render2.controls);
      expect(render2.controls).toBe(render3.controls);

      expect(render1.mermaid).toBe(render2.mermaid);
      expect(render2.mermaid).toBe(render3.mermaid);

      await act(async () => {
        root.unmount();
      });
      container.remove();
    } finally {
      harness.restore();
    }
  });
});
