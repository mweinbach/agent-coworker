import { describe, expect, mock, test } from "bun:test";
import {
  act,
  createElement,
  type KeyboardEvent as ReactKeyboardEvent,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import { ComposerMentionInput } from "../src/ui/chat/ComposerMentionInput";
import { placeComposerMentionMenu } from "../src/ui/chat/composerMentionGeometry";
import type { MentionCatalog } from "../src/ui/chat/composerMentions";
import { OverlayStackProvider } from "../src/ui/OverlayStack";
import { setupJsdom } from "./jsdomHarness";

const CATALOG: MentionCatalog = {
  items: [
    {
      kind: "skill",
      name: "alpha",
      label: "Alpha",
      description: "Alpha skill",
      badge: "Built-in",
    },
    {
      kind: "skill",
      name: "beta",
      label: "Beta",
      description: "Beta skill",
      badge: "Project",
    },
  ],
  names: ["alpha", "beta"],
  kindByName: new Map([
    ["alpha", "skill"],
    ["beta", "skill"],
  ]),
};

function MentionHarness({
  onComposerKeyDown,
}: {
  onComposerKeyDown: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => void;
}) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  return createElement(
    OverlayStackProvider,
    null,
    createElement(ComposerMentionInput, {
      value,
      setValue,
      onKeyDown: onComposerKeyDown,
      placeholder: "Message",
      textareaRef,
      catalog: CATALOG,
      ariaLabel: "Message input",
      textareaScrollClassName: "max-h-24 overflow-y-auto",
    }),
  );
}

type ReactTextareaProps = {
  onChange?: (event: { currentTarget: HTMLTextAreaElement; target: HTMLTextAreaElement }) => void;
  onCompositionEnd?: (event: {
    currentTarget: HTMLTextAreaElement;
    target: HTMLTextAreaElement;
  }) => void;
  onCompositionStart?: () => void;
};

function reactTextareaProps(textarea: HTMLTextAreaElement): ReactTextareaProps {
  const propsKey = Object.keys(textarea).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) return {};
  const props = (textarea as unknown as Record<string, unknown>)[propsKey];
  return typeof props === "object" && props !== null ? (props as ReactTextareaProps) : {};
}

async function setTextareaValue(
  window: Window,
  textarea: HTMLTextAreaElement,
  value: string,
): Promise<void> {
  await act(async () => {
    const valueSetter = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(textarea),
      "value",
    )?.set;
    if (!valueSetter) throw new Error("missing textarea value setter");
    valueSetter.call(textarea, value);
    textarea.selectionStart = value.length;
    textarea.selectionEnd = value.length;
    reactTextareaProps(textarea).onChange?.({
      currentTarget: textarea,
      target: textarea,
    });
    textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}

async function dispatchKeyboard(
  window: Window,
  textarea: HTMLTextAreaElement,
  key: string,
  options: { followWithSelect?: boolean; isComposing?: boolean; keyCode?: number } = {},
): Promise<void> {
  await act(async () => {
    const event = new window.KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key,
    });
    if (options.isComposing !== undefined) {
      Object.defineProperty(event, "isComposing", { value: options.isComposing });
    }
    if (options.keyCode !== undefined) {
      Object.defineProperty(event, "keyCode", { value: options.keyCode });
    }
    textarea.dispatchEvent(event);
    if (options.followWithSelect) {
      textarea.dispatchEvent(new window.Event("select", { bubbles: true }));
    }
  });
}

describe("composer mention input", () => {
  test.each([
    1, 1.25, 2,
  ])("pixel-aligns caret placement and flips inside the viewport at %px scale", (devicePixelRatio) => {
    const above = placeComposerMentionMenu({
      anchor: { bottom: 704.4, left: 920.3, lineHeight: 24, right: 920.3, top: 680.4 },
      devicePixelRatio,
      menuHeight: 256,
      menuWidth: 384,
      viewportHeight: 720,
      viewportWidth: 1_024,
    });
    expect(above.placement).toBe("above");
    expect(above.left).toBeLessThanOrEqual(632);
    expect(above.top).toBeGreaterThanOrEqual(8);
    expect(Number.isInteger(above.left * devicePixelRatio)).toBe(true);
    expect(Number.isInteger(above.top * devicePixelRatio)).toBe(true);

    const below = placeComposerMentionMenu({
      anchor: { bottom: 48.2, left: -20, lineHeight: 24, right: -20, top: 24.2 },
      devicePixelRatio,
      menuHeight: 256,
      menuWidth: 384,
      viewportHeight: 720,
      viewportWidth: 1_024,
    });
    expect(below.placement).toBe("below");
    expect(below.left).toBe(8);
    expect(below.top).toBeGreaterThanOrEqual(48.2);
    expect(below.top + Math.min(256, below.maxHeight)).toBeLessThanOrEqual(712);
  });

  test("connects the combobox and listbox with a stable active descendant", async () => {
    const harness = setupJsdom();
    const onComposerKeyDown = mock((_event: ReactKeyboardEvent<HTMLTextAreaElement>) => {});

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);
      await act(async () => {
        root.render(createElement(MentionHarness, { onComposerKeyDown }));
      });

      const textarea = container.querySelector("textarea");
      if (!textarea) throw new Error("missing textarea");
      textarea.focus();
      await setTextareaValue(harness.dom.window, textarea, "@");

      const listbox = harness.dom.window.document.querySelector('[role="listbox"]');
      if (!(listbox instanceof harness.dom.window.HTMLElement)) {
        throw new Error("missing listbox");
      }
      expect(textarea.getAttribute("role")).toBe("combobox");
      expect(textarea.getAttribute("aria-controls")).toBe(listbox.id);
      expect(textarea.getAttribute("aria-expanded")).toBe("true");
      expect(listbox.getAttribute("aria-label")).toBe("Mentions");

      await dispatchKeyboard(harness.dom.window, textarea, "ArrowDown");
      const betaActiveId = textarea.getAttribute("aria-activedescendant");
      expect(betaActiveId).toContain("-skill-beta");
      expect(harness.dom.window.document.getElementById(betaActiveId ?? "")?.textContent).toContain(
        "@beta",
      );

      await setTextareaValue(harness.dom.window, textarea, "@b");
      expect(textarea.getAttribute("aria-activedescendant")).toBe(betaActiveId);

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test("selects the active option by keyboard without submitting the composer", async () => {
    const harness = setupJsdom();
    const onComposerKeyDown = mock((_event: ReactKeyboardEvent<HTMLTextAreaElement>) => {});

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);
      await act(async () => {
        root.render(createElement(MentionHarness, { onComposerKeyDown }));
      });
      const textarea = container.querySelector("textarea");
      if (!textarea) throw new Error("missing textarea");

      textarea.focus();
      await setTextareaValue(harness.dom.window, textarea, "@");
      await dispatchKeyboard(harness.dom.window, textarea, "ArrowDown");
      await dispatchKeyboard(harness.dom.window, textarea, "Enter");
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(textarea.value).toBe("@beta ");
      expect(onComposerKeyDown).not.toHaveBeenCalled();
      expect(harness.dom.window.document.activeElement).toBe(textarea);
      expect(harness.dom.window.document.querySelector('[role="listbox"]')).toBeNull();

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test("closes on Escape without submitting the composer", async () => {
    const harness = setupJsdom();
    const onComposerKeyDown = mock((_event: ReactKeyboardEvent<HTMLTextAreaElement>) => {});

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);
      await act(async () => {
        root.render(createElement(MentionHarness, { onComposerKeyDown }));
      });
      const textarea = container.querySelector("textarea");
      if (!textarea) throw new Error("missing textarea");

      textarea.focus();
      await setTextareaValue(harness.dom.window, textarea, "@");
      await dispatchKeyboard(harness.dom.window, textarea, "Escape", { followWithSelect: true });

      expect(harness.dom.window.document.querySelector('[role="listbox"]')).toBeNull();
      expect(harness.dom.window.document.activeElement).toBe(textarea);
      expect(onComposerKeyDown).not.toHaveBeenCalled();

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test("selects on pointer down before a following textarea blur", async () => {
    const harness = setupJsdom();
    const onComposerKeyDown = mock((_event: ReactKeyboardEvent<HTMLTextAreaElement>) => {});

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);
      await act(async () => {
        root.render(createElement(MentionHarness, { onComposerKeyDown }));
      });
      const textarea = container.querySelector("textarea");
      if (!textarea) throw new Error("missing textarea");

      textarea.focus();
      await setTextareaValue(harness.dom.window, textarea, "@al");
      const option = harness.dom.window.document.querySelector('[role="option"]');
      if (!(option instanceof harness.dom.window.HTMLElement)) {
        throw new Error("missing mention option");
      }

      await act(async () => {
        const pointerDown = new harness.dom.window.Event("pointerdown", {
          bubbles: true,
          cancelable: true,
        });
        Object.defineProperty(pointerDown, "button", { value: 0 });
        Object.defineProperty(pointerDown, "pointerType", { value: "mouse" });
        option.dispatchEvent(pointerDown);
        textarea.blur();
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(textarea.value).toBe("@alpha ");
      expect(harness.dom.window.document.querySelector('[role="listbox"]')).toBeNull();

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test("does not consume IME composition keys or replace the composing token", async () => {
    const harness = setupJsdom();
    const onComposerKeyDown = mock((_event: ReactKeyboardEvent<HTMLTextAreaElement>) => {});

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);
      await act(async () => {
        root.render(createElement(MentionHarness, { onComposerKeyDown }));
      });
      const textarea = container.querySelector("textarea");
      if (!textarea) throw new Error("missing textarea");

      await setTextareaValue(harness.dom.window, textarea, "@");
      await act(async () => {
        reactTextareaProps(textarea).onCompositionStart?.();
        textarea.dispatchEvent(
          new harness.dom.window.CompositionEvent("compositionstart", { bubbles: true }),
        );
      });
      await dispatchKeyboard(harness.dom.window, textarea, "Enter", {
        isComposing: true,
        keyCode: 229,
      });

      expect(textarea.value).toBe("@");
      expect(onComposerKeyDown).toHaveBeenCalledTimes(1);
      expect(harness.dom.window.document.querySelector('[role="listbox"]')).toBeNull();

      await act(async () => {
        reactTextareaProps(textarea).onCompositionEnd?.({
          currentTarget: textarea,
          target: textarea,
        });
        textarea.dispatchEvent(
          new harness.dom.window.CompositionEvent("compositionend", { bubbles: true }),
        );
      });
      expect(harness.dom.window.document.querySelector('[role="listbox"]')).not.toBeNull();

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });
});
