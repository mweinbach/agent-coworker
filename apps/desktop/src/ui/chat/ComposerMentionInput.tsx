import {
  type ClipboardEvent as ReactClipboardEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/utils";
import { MessageComposerTextarea } from "@/ui/composer/MessageComposer";
import { useOverlayOwner } from "@/ui/OverlayStack";
import { ComposerHighlightOverlay } from "./ComposerHighlightOverlay";
import { ComposerMentionMenu } from "./ComposerMentionMenu";
import {
  detectActiveMentionQuery,
  filterMentionItems,
  type MentionCatalog,
  type MentionItem,
} from "./composerMentions";

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
  const listboxId = useId();
  const [menuOpen, setMenuOpen] = useState(false);
  const [items, setItems] = useState<MentionItem[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
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

  // Keep the overlay aligned with the textarea after value changes (which can
  // change scroll position / wrapping).
  useLayoutEffect(() => {
    syncScroll();
  }, [syncScroll]);

  const refreshMenu = useCallback(
    (text: string, caret: number) => {
      if (disabled) {
        setMenuOpen(false);
        return;
      }
      const active = detectActiveMentionQuery(text, caret);
      if (!active) {
        setMenuOpen(false);
        return;
      }
      const next = filterMentionItems(catalog, active.query);
      setItems(next);
      setQuery(active.query);
      setActiveIndex(0);
      setMenuOpen(true);
    },
    [catalog, disabled],
  );

  const refreshFromCaret = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    refreshMenu(textarea.value, textarea.selectionStart ?? textarea.value.length);
  }, [refreshMenu, textareaRef]);

  const handleKeyUp = useCallback(
    (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === "Escape") return;
      refreshFromCaret();
    },
    [refreshFromCaret],
  );

  const handleSelect = useCallback(
    (item: MentionItem) => {
      const textarea = textareaRef.current;
      const caret = textarea ? (textarea.selectionStart ?? value.length) : value.length;
      const active = detectActiveMentionQuery(value, caret);
      const start = active ? active.start : caret;
      const insert = `@${item.name} `;
      const nextText = value.slice(0, start) + insert + value.slice(caret);
      setValue(nextText);
      setMenuOpen(false);
      const nextCaret = start + insert.length;
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

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      if (menuOpen) {
        if (event.key === "Escape") {
          mentionMenuOwner?.handleEscape(event);
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
              setActiveIndex((index) => (index + 1) % items.length);
              return;
            case "ArrowUp":
              event.preventDefault();
              setActiveIndex((index) => (index - 1 + items.length) % items.length);
              return;
            case "Enter":
              event.preventDefault();
              handleSelect(items[activeIndex] ?? items[0]);
              return;
            default:
              break;
          }
        }
      }
      onKeyDown(event);
    },
    [activeIndex, handleSelect, items, mentionMenuOwner, menuOpen, onKeyDown],
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

  const activeOptionId =
    menuOpen && items.length > 0 ? `${listboxId}-option-${activeIndex}` : undefined;

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
          "relative z-[1] break-words text-transparent caret-foreground",
          textareaClassName,
          textareaScrollClassName,
        )}
        onChange={(event) => {
          setValue(event.currentTarget.value);
          refreshMenu(
            event.currentTarget.value,
            event.currentTarget.selectionStart ?? event.currentTarget.value.length,
          );
        }}
        onKeyDown={handleKeyDown}
        onKeyUp={handleKeyUp}
        onClick={refreshFromCaret}
        onScroll={syncScroll}
        onPaste={handlePaste}
        onBlur={() => setMenuOpen(false)}
      />
      {menuOpen ? (
        <ComposerMentionMenu
          id={listboxId}
          activeOptionIdPrefix={listboxId}
          items={items}
          activeIndex={activeIndex}
          query={query}
          onSelect={handleSelect}
          onHover={setActiveIndex}
          zIndex={mentionMenuOwner?.zIndex}
        />
      ) : null}
    </div>
  );
}
