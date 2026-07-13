import {
  type ClipboardEvent as ReactClipboardEvent,
  type CompositionEvent as ReactCompositionEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { isImeComposing } from "@/lib/keyboard";
import { cn } from "@/lib/utils";
import { MessageComposerTextarea } from "@/ui/composer/MessageComposer";
import { useOverlayOwner } from "@/ui/OverlayStack";
import { ComposerHighlightOverlay } from "./ComposerHighlightOverlay";
import { ComposerMentionMenu } from "./ComposerMentionMenu";
import {
  type ComposerCaretAnchor,
  fallbackComposerCaretAnchor,
  measureComposerCaretAnchor,
  syncComposerOverlayGeometry,
} from "./composerMentionGeometry";
import {
  detectActiveMentionQuery,
  filterMentionItems,
  type MentionCatalog,
  type MentionItem,
} from "./composerMentions";

function mentionItemKey(item: MentionItem): string {
  return `${item.kind}-${item.name}`;
}

function mentionOptionId(prefix: string, item: MentionItem): string {
  return `${prefix}-option-${mentionItemKey(item)}`;
}

function sameCaretAnchor(current: ComposerCaretAnchor | null, next: ComposerCaretAnchor): boolean {
  return (
    current !== null &&
    current.bottom === next.bottom &&
    current.left === next.left &&
    current.lineHeight === next.lineHeight &&
    current.right === next.right &&
    current.top === next.top
  );
}

/**
 * Composer text input with inline @-mention support. Wraps the plain
 * `MessageComposerTextarea` with a highlight overlay (boxed mentions) and an
 * autocomplete menu, while preserving the textarea as the single source of
 * truth (`value`/`setValue`) and delegating non-menu keystrokes to the parent's
 * send handler (`onKeyDown`).
 */
export function ComposerMentionInput(props: {
  value: string;
  setValue: (text: string) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => void;
  placeholder: string;
  disabled?: boolean;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  catalog: MentionCatalog;
  ariaLabel?: string;
  /** When clipboard paste includes files, invoke instead of inserting text. */
  onPasteFiles?: (files: File[]) => void;
  /**
   * Extra classes applied to BOTH the textarea and the highlight overlay so
   * their typography/padding stay identical (and the boxes line up). Use this
   * for composers with non-default font size / line height.
   */
  textareaClassName?: string;
  /**
   * Extra classes applied to ONLY the textarea (not the highlight overlay).
   * Use for scroll/height behavior (`min-h`, `max-h`, `overflow`) that must not
   * be mirrored onto the overlay — the overlay stays `overflow-hidden` and is
   * scroll-synced manually, so giving it its own scroll would desync the boxes.
   */
  textareaScrollClassName?: string;
}) {
  const {
    value,
    setValue,
    onKeyDown,
    placeholder,
    disabled,
    textareaRef,
    catalog,
    ariaLabel,
    onPasteFiles,
    textareaClassName,
    textareaScrollClassName,
  } = props;
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const isComposingRef = useRef(false);
  const suppressCaretRefreshRef = useRef(false);
  const caretRef = useRef(0);
  const activeMentionRef = useRef<{ end: number; start: number } | null>(null);
  const listboxId = useId();
  const [menuOpen, setMenuOpen] = useState(false);
  const [items, setItems] = useState<MentionItem[]>([]);
  const [activeItemKey, setActiveItemKey] = useState<string | null>(null);
  const [caretAnchor, setCaretAnchor] = useState<ComposerCaretAnchor | null>(null);
  const [query, setQuery] = useState("");
  const mentionMenuOwner = useOverlayOwner({
    active: menuOpen,
    label: "Composer mentions",
    onDismiss: () => setMenuOpen(false),
    restoreFocus: () => textareaRef.current,
  });

  const syncScroll = useCallback(() => {
    const textarea = textareaRef.current;
    const overlay = overlayRef.current;
    if (!textarea || !overlay) return;
    overlay.scrollTop = textarea.scrollTop;
    overlay.scrollLeft = textarea.scrollLeft;
  }, [textareaRef]);

  const updateGeometry = useCallback(() => {
    const textarea = textareaRef.current;
    const overlay = overlayRef.current;
    if (!textarea || !overlay) return;
    syncComposerOverlayGeometry(textarea, overlay);
    syncScroll();
    if (!menuOpen) return;
    const nextAnchor =
      measureComposerCaretAnchor(overlay, caretRef.current, value.length) ??
      fallbackComposerCaretAnchor(textarea);
    setCaretAnchor((current) => (sameCaretAnchor(current, nextAnchor) ? current : nextAnchor));
  }, [menuOpen, syncScroll, textareaRef, value]);

  // Value-driven changes can alter wrapping and native textarea scroll. Resolve
  // metrics before measuring the caret for the picker.
  useLayoutEffect(() => {
    updateGeometry();
  }, [updateGeometry]);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const observer = new ResizeObserver(updateGeometry);
    observer.observe(textarea);
    const mutationObserver = new MutationObserver(updateGeometry);
    mutationObserver.observe(textarea, {
      attributeFilter: ["class", "style"],
      attributes: true,
    });
    const fonts = document.fonts;
    const handleViewportChange = () => updateGeometry();
    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("scroll", handleViewportChange, true);
    window.visualViewport?.addEventListener("resize", handleViewportChange);
    window.visualViewport?.addEventListener("scroll", handleViewportChange);
    fonts?.addEventListener("loadingdone", handleViewportChange);
    void fonts?.ready.then(handleViewportChange);
    return () => {
      observer.disconnect();
      mutationObserver.disconnect();
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("scroll", handleViewportChange, true);
      window.visualViewport?.removeEventListener("resize", handleViewportChange);
      window.visualViewport?.removeEventListener("scroll", handleViewportChange);
      fonts?.removeEventListener("loadingdone", handleViewportChange);
    };
  }, [textareaRef, updateGeometry]);

  const refreshMenu = useCallback(
    (text: string, caret: number) => {
      caretRef.current = caret;
      if (disabled || isComposingRef.current) {
        activeMentionRef.current = null;
        setMenuOpen(false);
        return;
      }
      const active = detectActiveMentionQuery(text, caret);
      if (!active) {
        activeMentionRef.current = null;
        setMenuOpen(false);
        return;
      }
      const next = filterMentionItems(catalog, active.query);
      activeMentionRef.current = { end: caret, start: active.start };
      setItems(next);
      setQuery(active.query);
      setActiveItemKey((current) =>
        current && next.some((item) => mentionItemKey(item) === current)
          ? current
          : next[0]
            ? mentionItemKey(next[0])
            : null,
      );
      setMenuOpen(true);
    },
    [catalog, disabled],
  );

  const refreshFromCaret = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea || suppressCaretRefreshRef.current) return;
    refreshMenu(textarea.value, textarea.selectionStart ?? textarea.value.length);
  }, [refreshMenu, textareaRef]);

  const refreshFromPointer = useCallback(() => {
    suppressCaretRefreshRef.current = false;
    refreshFromCaret();
  }, [refreshFromCaret]);

  const activeIndex = Math.max(
    0,
    items.findIndex((item) => mentionItemKey(item) === activeItemKey),
  );

  const handleSelect = useCallback(
    (item: MentionItem) => {
      const textarea = textareaRef.current;
      const liveCaret = textarea ? (textarea.selectionStart ?? value.length) : value.length;
      const active = activeMentionRef.current ?? {
        end: liveCaret,
        start: detectActiveMentionQuery(value, liveCaret)?.start ?? liveCaret,
      };
      const insert = `@${item.name} `;
      const nextText = value.slice(0, active.start) + insert + value.slice(active.end);
      setValue(nextText);
      setMenuOpen(false);
      activeMentionRef.current = null;
      const nextCaret = active.start + insert.length;
      caretRef.current = nextCaret;
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.focus();
        el.selectionStart = nextCaret;
        el.selectionEnd = nextCaret;
      });
    },
    [setValue, textareaRef, value],
  );

  const dismissMenuFromEscape = useCallback((event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    event.preventDefault();
    event.stopPropagation();
    suppressCaretRefreshRef.current = true;
    setMenuOpen(false);
    activeMentionRef.current = null;
  }, []);

  const handleKeyDownCapture = useCallback(
    (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      const isComposing = isImeComposing(event.nativeEvent);
      if (event.key !== "Escape") suppressCaretRefreshRef.current = false;
      if (menuOpen && event.key === "Escape" && !isComposing) {
        dismissMenuFromEscape(event);
      }
    },
    [dismissMenuFromEscape, menuOpen],
  );

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      const isComposing = isImeComposing(event.nativeEvent);
      if (isComposing) {
        onKeyDown(event);
        return;
      }
      if (menuOpen) {
        if (event.key === "Escape") {
          dismissMenuFromEscape(event);
          return;
        }
        if (event.key === "Tab") {
          // Close without selecting so Tab can move focus normally.
          setMenuOpen(false);
          return;
        }
        if (items.length > 0) {
          switch (event.key) {
            case "ArrowDown":
              event.preventDefault();
              {
                const nextItem = items[(activeIndex + 1) % items.length] ?? items[0];
                if (nextItem) setActiveItemKey(mentionItemKey(nextItem));
              }
              return;
            case "ArrowUp":
              event.preventDefault();
              {
                const previousItem =
                  items[(activeIndex - 1 + items.length) % items.length] ?? items[items.length - 1];
                if (previousItem) setActiveItemKey(mentionItemKey(previousItem));
              }
              return;
            case "Enter":
              event.preventDefault();
              {
                const activeItem = items[activeIndex] ?? items[0];
                if (activeItem) handleSelect(activeItem);
              }
              return;
            default:
              break;
          }
        }
      }
      onKeyDown(event);
    },
    [activeIndex, dismissMenuFromEscape, handleSelect, items, menuOpen, onKeyDown],
  );

  const handleCompositionStart = useCallback(() => {
    isComposingRef.current = true;
    setMenuOpen(false);
  }, []);

  const handleCompositionEnd = useCallback(
    (event: ReactCompositionEvent<HTMLTextAreaElement>) => {
      isComposingRef.current = false;
      suppressCaretRefreshRef.current = false;
      refreshMenu(
        event.currentTarget.value,
        event.currentTarget.selectionStart ?? event.currentTarget.value.length,
      );
    },
    [refreshMenu],
  );

  const handlePaste = useCallback(
    (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
      if (!onPasteFiles || disabled) return;
      const files = event.clipboardData?.files;
      if (!files || files.length === 0) return;
      event.preventDefault();
      onPasteFiles(Array.from(files));
    },
    [disabled, onPasteFiles],
  );

  const getOptionId = useCallback(
    (item: MentionItem) => mentionOptionId(listboxId, item),
    [listboxId],
  );
  const activeItem = items[activeIndex];
  const activeOptionId = menuOpen && activeItem ? getOptionId(activeItem) : undefined;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <ComposerHighlightOverlay
        ref={overlayRef}
        text={value}
        catalog={catalog}
        className={textareaClassName}
      />
      <MessageComposerTextarea
        ref={textareaRef}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={menuOpen}
        aria-controls={menuOpen ? listboxId : undefined}
        aria-activedescendant={activeOptionId}
        aria-autocomplete="list"
        aria-haspopup="listbox"
        className={cn(
          "relative z-[1] break-words text-foreground caret-foreground",
          textareaClassName,
          textareaScrollClassName,
        )}
        onChange={(event) => {
          suppressCaretRefreshRef.current = false;
          setValue(event.currentTarget.value);
          refreshMenu(
            event.currentTarget.value,
            event.currentTarget.selectionStart ?? event.currentTarget.value.length,
          );
        }}
        onKeyDownCapture={handleKeyDownCapture}
        onKeyDown={handleKeyDown}
        onClick={refreshFromPointer}
        onSelect={refreshFromCaret}
        onScroll={() => {
          syncScroll();
          updateGeometry();
        }}
        onPaste={handlePaste}
        onCompositionStart={handleCompositionStart}
        onCompositionEnd={handleCompositionEnd}
        onBlur={() => setMenuOpen(false)}
      />
      {menuOpen && caretAnchor ? (
        <ComposerMentionMenu
          anchor={caretAnchor}
          id={listboxId}
          optionId={getOptionId}
          items={items}
          activeIndex={activeIndex}
          query={query}
          onSelect={handleSelect}
          onHover={(index) => {
            const item = items[index];
            if (item) setActiveItemKey(mentionItemKey(item));
          }}
          zIndex={mentionMenuOwner?.zIndex}
        />
      ) : null}
    </div>
  );
}
