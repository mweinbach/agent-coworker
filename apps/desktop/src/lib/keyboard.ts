type CompositionKeyboardEvent = {
  isComposing?: boolean;
  keyCode?: number;
};

type EnterKeyboardEvent = {
  key: string;
  nativeEvent: CompositionKeyboardEvent;
};

type PlainEnterKeyboardEvent = EnterKeyboardEvent & {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
};

export function isImeComposing(event: CompositionKeyboardEvent): boolean {
  return event.isComposing === true || event.keyCode === 229;
}

export function isEnterWithoutIme(event: EnterKeyboardEvent): boolean {
  return event.key === "Enter" && !isImeComposing(event.nativeEvent);
}

export function isPlainEnterWithoutIme(event: PlainEnterKeyboardEvent): boolean {
  return (
    isEnterWithoutIme(event) && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey
  );
}
