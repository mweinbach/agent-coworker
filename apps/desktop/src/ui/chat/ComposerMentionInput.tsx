import {
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { PromptInputTextarea } from "@/components/ai-elements/prompt-input";
import { ComposerHighlightOverlay } from "./ComposerHighlightOverlay";
import {
  detectActiveMentionQuery,
  filterMentionItems,
  type MentionCatalog,
  type MentionItem,
} from "./composerMentions";
import { ComposerMentionMenu } from "./ComposerMentionMenu";

/**
 * Composer text input with inline @-mention support. Wraps the plain
 * `PromptInputTextarea` with a highlight overlay (boxed mentions) and an
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
}) {
  const { value, setValue, onKeyDown, placeholder, disabled, textareaRef, catalog, ariaLabel } =
    props;
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [items, setItems] = useState<MentionItem[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);

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
  }, [value, syncScroll]);

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
      if (next.length === 0) {
        setMenuOpen(false);
        return;
      }
      setItems(next);
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
      if (menuOpen && items.length > 0) {
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
          case "Tab":
            event.preventDefault();
            handleSelect(items[activeIndex] ?? items[0]);
            return;
          case "Escape":
            event.preventDefault();
            event.stopPropagation();
            setMenuOpen(false);
            return;
          default:
            break;
        }
      }
      onKeyDown(event);
    },
    [activeIndex, handleSelect, items, menuOpen, onKeyDown],
  );

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <ComposerHighlightOverlay ref={overlayRef} text={value} catalog={catalog} />
      <PromptInputTextarea
        ref={textareaRef}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        aria-label={ariaLabel}
        className="relative z-[1] break-words text-transparent caret-foreground"
        onChange={(event) => {
          setValue(event.currentTarget.value);
          refreshMenu(
            event.currentTarget.value,
            event.currentTarget.selectionStart ?? event.currentTarget.value.length,
          );
        }}
        onKeyDown={handleKeyDown}
        onKeyUp={refreshFromCaret}
        onClick={refreshFromCaret}
        onScroll={syncScroll}
        onBlur={() => setMenuOpen(false)}
      />
      {menuOpen ? (
        <ComposerMentionMenu
          items={items}
          activeIndex={activeIndex}
          onSelect={handleSelect}
          onHover={setActiveIndex}
        />
      ) : null}
    </div>
  );
}
